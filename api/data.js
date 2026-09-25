import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TEMPLATE_KEY = 'signature_template';
const SESSION_PREFIX = 'session:';
const SESSION_LIST = 'session_list';
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

function genId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);

  // ============ 公开接口 ============

  // 读全局模板（标题、条款、文案）
  if (action === 'template' && req.method === 'GET') {
    try {
      const t = await kv.get(TEMPLATE_KEY);
      return res.status(200).json(t || DEFAULT_TEMPLATE);
    } catch (err) {
      console.error('KV read template error:', err);
      return res.status(200).json(DEFAULT_TEMPLATE);
    }
  }

  // 读会话（客户页加载时调用）
  if (action === 'session' && req.method === 'GET') {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const s = await kv.get(SESSION_PREFIX + id);
      if (!s) return res.status(404).json({ error: 'Session not found' });
      return res.status(200).json(s);
    } catch (err) {
      console.error('KV read session error:', err);
      return res.status(500).json({ error: 'Failed to read session' });
    }
  }

  // 客户提交
  if (action === 'submit' && req.method === 'POST') {
    try {
      const body = req.body || {};
      const {
        sessionId,
        customerName,
        customerCpf,
        customerAddress,
        ip,
        pdfBase64,
        submittedAt
      } = body;

      if (!sessionId || !customerName || !customerCpf) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // 检查 session 是否存在
      const s = await kv.get(SESSION_PREFIX + sessionId);
      if (!s) return res.status(404).json({ error: 'Session not found' });

      const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const record = {
        id,
        sessionId,
        customerName,
        customerCpf,
        customerAddress: customerAddress || '',
        ip: ip || req.headers['x-forwarded-for'] || 'unknown',
        submittedAt: submittedAt || new Date().toISOString(),
        pdf: pdfBase64 || null
      };

      await kv.set(SUBMISSION_PREFIX + id, record);
      await kv.lpush(SUBMISSION_LIST, id);

      // 更新 session 状态
      s.status = 'signed';
      s.submittedAt = record.submittedAt;
      s.submissionId = id;
      await kv.set(SESSION_PREFIX + sessionId, s);

      return res.status(200).json({ ok: true, id });
    } catch (err) {
      console.error('Submit error:', err);
      return res.status(500).json({ error: 'Failed to save submission' });
    }
  }

  // ============ 需要鉴权的接口 ============

  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 写模板
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

  // 创建会话
  if (action === 'create_session' && req.method === 'POST') {
    try {
      const incoming = (req.body && req.body.data) || {};
      const id = genId();
      const session = {
        id,
        goods: {
          invoice: incoming.invoice || '',
          bl: incoming.bl || '',
          description: incoming.description || '',
          quantity: incoming.quantity || '',
          value: incoming.value || ''
        },
        note: incoming.note || '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        submittedAt: null,
        submissionId: null
      };
      await kv.set(SESSION_PREFIX + id, session);
      await kv.lpush(SESSION_LIST, id);
      return res.status(200).json({ ok: true, session });
    } catch (err) {
      console.error('Create session error:', err);
      return res.status(500).json({ error: 'Failed to create session' });
    }
  }

  // 列出会话
  if (action === 'sessions' && req.method === 'GET') {
    try {
      const ids = await kv.lrange(SESSION_LIST, 0, 199);
      const records = [];
      for (const id of ids) {
        const s = await kv.get(SESSION_PREFIX + id);
        if (s) records.push(s);
      }
      return res.status(200).json({ sessions: records });
    } catch (err) {
      console.error('List sessions error:', err);
      return res.status(500).json({ error: 'Failed to list sessions' });
    }
  }

  // 删除会话
  if (action === 'delete_session' && req.method === 'POST') {
    try {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await kv.del(SESSION_PREFIX + id);
      await kv.lrem(SESSION_LIST, 0, id);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Delete session error:', err);
      return res.status(500).json({ error: 'Failed to delete session' });
    }
  }

  // 列出提交
  if (action === 'submissions' && req.method === 'GET') {
    try {
      const ids = await kv.lrange(SUBMISSION_LIST, 0, 199);
      const records = [];
      for (const id of ids) {
        const r = await kv.get(SUBMISSION_PREFIX + id);
        if (r) {
          records.push({
            id: r.id,
            sessionId: r.sessionId,
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

  // 取单个 PDF
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
