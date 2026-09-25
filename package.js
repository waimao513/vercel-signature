// api/data.js
// 统一数据接口
// GET  /api/data?action=template         → 读模板
// POST /api/data  { action:'template', token, data }  → 写模板
// POST /api/data  { action:'submit', data }           → 存提交
// GET  /api/data?action=submissions&token=xxx         → 列出提交
// GET  /api/data?action=pdf&id=xxx&token=xxx          → 取单个 PDF

import { kv } from '@vercel/kv';

const TEMPLATE_KEY = 'signature_template';
const SUBMISSION_PREFIX = 'submission:';

const DEFAULT_TEMPLATE = {
  title: '退运申请意向书',
  subtitle: 'Solicitação de Devolução de Mercadoria',
  exporter: { name: 'Shenzhen ABC Electronics Co., Ltd.', address: '深圳市宝安区XX路XX号' },
  forwarder: { name: 'ABC Logística Internacional Ltda.' },
  goods: {
    invoice: 'INV-2026-001',
    bl: 'BL-123456',
    description: '电子配件 / Componentes Eletrônicos',
    quantity: '500 units',
    value: 'USD 12,500.00'
  },
  terms: [
    '因多种原因延误未能及时补充巴西进口关税所需的信息/文件，导致上述货物在巴西海关清关延误并被要求强制退回。现本人正式向出口商提出退货退款申请，并确认：',
    '退运原因是本人自身清关延误，与货物质量或出口商履约无关；',
    '本人授权货代公司代表本人办理退运相关手续；',
    '退运产生的巴西境内费用及国际运费由本人承担；',
    '出口商在收到货物实际离境巴西的证明后，启动退款流程。'
  ],
  confirmText: '本人确认已阅读并同意上述条款 / Confirmo que li e concordo com os termos acima',
  doneMessage: '请截图本页面并发送给您的业务对接人。\nPor favor, tire um print desta tela e envie ao seu contato comercial.',
  updatedAt: null
};

function checkAuth(req) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  return token && token === process.env.ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action;

  // === 公开接口 ===

  // 读模板
  if (action === 'template' && req.method === 'GET') {
    try {
      const t = await kv.get(TEMPLATE_KEY);
      return res.status(200).json(t || DEFAULT_TEMPLATE);
    } catch {
      return res.status(200).json(DEFAULT_TEMPLATE);
    }
  }

  // 客户提交
  if (action === 'submit' && req.method === 'POST') {
    try {
      const { customerName, customerCpf, customerAddress, ip, pdfBase64, submittedAt } = req.body;
      if (!customerName || !customerCpf) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const record = {
        id,
        customerName,
        customerCpf,
        customerAddress,
        ip: ip || req.headers['x-forwarded-for'] || 'unknown',
        submittedAt: submittedAt || new Date().toISOString(),
        pdf: pdfBase64  // base64 存储
      };
      await kv.set(SUBMISSION_PREFIX + id, record);
      // 同时加入列表
      await kv.lpush('submission_ids', id);
      return res.status(200).json({ ok: true, id });
    } catch (err) {
      console.error('Submit error:', err);
      return res.status(500).json({ error: 'Failed to save submission' });
    }
  }

  // === 需要鉴权的接口 ===

  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 写模板
  if (action === 'template' && req.method === 'POST') {
    try {
      const template = { ...DEFAULT_TEMPLATE, ...req.body.data, updatedAt: new Date().toISOString() };
      await kv.set(TEMPLATE_KEY, template);
      return res.status(200).json({ ok: true, template });
    } catch {
      return res.status(500).json({ error: 'Failed to save template' });
    }
  }

  // 列出提交
  if (action === 'submissions' && req.method === 'GET') {
    try {
      const ids = await kv.lrange('submission_ids', 0, 99);
      const records = [];
      for (const id of ids) {
        const r = await kv.get(SUBMISSION_PREFIX + id);
        if (r) records.push({
          id: r.id,
          customerName: r.customerName,
          customerCpf: r.customerCpf,
          customerAddress: r.customerAddress,
          ip: r.ip,
          submittedAt: r.submittedAt
        });
      }
      return res.status(200).json({ submissions: records });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to list' });
    }
  }

  // 取单个 PDF
  if (action === 'pdf' && req.method === 'GET') {
    try {
      const { id } = req.query;
      const r = await kv.get(SUBMISSION_PREFIX + id);
      if (!r || !r.pdf) return res.status(404).json({ error: 'Not found' });
      const base64 = r.pdf.replace(/^data:application\/pdf;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="solicitacao-${id}.pdf"`);
      return res.send(buffer);
    } catch {
      return res.status(500).json({ error: 'Failed to get PDF' });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}