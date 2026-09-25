// api/data.js
// API de dados unificada
// GET  /api/data?action=template              → ler template (público)
// POST /api/data  { action:'submit', ... }    → envio do cliente (público)
// POST /api/data  { action:'template', data } → salvar template (senha)
// GET  /api/data?action=submissions&token=xxx → listar envios (senha)
// GET  /api/data?action=pdf&id=xxx&token=xxx  → baixar PDF (senha)

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TEMPLATE_KEY = 'signature_template';
const SUBMISSION_PREFIX = 'submission:';
const SUBMISSION_LIST = 'submission_ids';

const DEFAULT_TEMPLATE = {
  title: 'Solicitação de Devolução de Mercadoria',
  subtitle: 'Termo de Intenção de Devolução',
  exporter: {
    name: 'Shenzhen ABC Electronics Co., Ltd.',
    address: 'Bao\'an District, Shenzhen, China'
  },
  forwarder: {
    name: 'ABC Logística Internacional Ltda.'
  },
  goods: {
    invoice: 'INV-2026-001',
    bl: 'BL-123456',
    description: 'Componentes Eletrônicos',
    quantity: '500 units',
    value: 'USD 12,500.00'
  },
  terms: [
    'Devido a diversos atrasos, não foi possível complementar tempestivamente as informações/documentos exigidos pela alfândega brasileira para o pagamento dos tributos de importação, resultando na retenção da mercadoria acima descrita pela Receita Federal do Brasil e na sua devolução obrigatória.',
    'O motivo da devolução é o atraso no desembaraço aduaneiro de responsabilidade exclusiva do importador, não tendo relação com a qualidade da mercadoria ou com o cumprimento das obrigações do exportador;',
    'O importador autoriza o despachante aduaneiro a representá-lo na execução dos procedimentos relativos à devolução;',
    'As despesas incorridas no Brasil e o frete internacional decorrentes da devolução correrão por conta do importador;',
    'O exportador iniciará o processo de reembolso após receber a comprovação de que a mercadoria deixou efetivamente o território brasileiro.'
  ],
  confirmText: 'Confirmo que li e concordo com os termos acima.',
  doneMessage: 'Por favor, tire um print desta tela e envie ao seu contato comercial.',
  updatedAt: null
};

function checkAuth(req) {
  const token =
    (req.headers.authorization || '').replace('Bearer ', '') ||
    req.query.token;
  return token && token === process.env.ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);

  // ============ Endpoints públicos ============

  if (action === 'template' && req.method === 'GET') {
    try {
      const t = await kv.get(TEMPLATE_KEY);
      return res.status(200).json(t || DEFAULT_TEMPLATE);
    } catch (err) {
      console.error('KV read template error:', err);
      return res.status(200).json(DEFAULT_TEMPLATE);
    }
  }

  if (action === 'submit' && req.method === 'POST') {
    try {
      const body = req.body || {};
      const {
        customerName,
        customerCpf,
        customerAddress,
        ip,
        pdfBase64,
        submittedAt
      } = body;

      if (!customerName || !customerCpf) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const record = {
        id,
        customerName,
        customerCpf,
        customerAddress: customerAddress || '',
        ip: ip || req.headers['x-forwarded-for'] || 'unknown',
        submittedAt: submittedAt || new Date().toISOString(),
        pdf: pdfBase64 || null
      };

      await kv.set(SUBMISSION_PREFIX + id, record);
      await kv.lpush(SUBMISSION_LIST, id);

      return res.status(200).json({ ok: true, id });
    } catch (err) {
      console.error('Submit error:', err);
      return res.status(500).json({ error: 'Failed to save submission' });
    }
  }

  // ============ Endpoints protegidos ============

  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (action === 'template' && req.method === 'POST') {
    try {
      const incoming = (req.body && req.body.data) || {};
      const template = {
        ...DEFAULT_TEMPLATE,
        ...incoming,
        updatedAt: new Date().toISOString()
      };
      await kv.set(TEMPLATE_KEY, template);
      return res.status(200).json({ ok: true, template });
    } catch (err) {
      console.error('KV write template error:', err);
      return res.status(500).json({ error: 'Failed to save template' });
    }
  }

  if (action === 'submissions' && req.method === 'GET') {
    try {
      const ids = await kv.lrange(SUBMISSION_LIST, 0, 199);
      const records = [];
      for (const id of ids) {
        const r = await kv.get(SUBMISSION_PREFIX + id);
        if (r) {
          records.push({
            id: r.id,
            customerName: r.customerName,
            customerCpf: r.customerCpf,
            customerAddress: r.customerAddress,
            ip: r.ip,
            submittedAt: r.submittedAt
          });
        }
      }
      return res.status(200).json({ submissions: records });
    } catch (err) {
      console.error('List submissions error:', err);
      return res.status(500).json({ error: 'Failed to list submissions' });
    }
  }

  if (action === 'pdf' && req.method === 'GET') {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const r = await kv.get(SUBMISSION_PREFIX + id);
      if (!r || !r.pdf) {
        return res.status(404).json({ error: 'Not found' });
      }

      const base64 = String(r.pdf).replace(/^data:application\/pdf;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="solicitacao-${id}.pdf"`
      );
      return res.send(buffer);
    } catch (err) {
      console.error('Get PDF error:', err);
      return res.status(500).json({ error: 'Failed to get PDF' });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
