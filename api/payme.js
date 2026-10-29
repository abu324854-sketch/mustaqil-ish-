// Payme Merchant API (JSON-RPC 2.0). Summalar tiyinda (1 so'm = 100 tiyin).
const store = require('./_lib/store');
const { safeEqual, markPaid } = require('./_lib/orders');

const TIMEOUT = 12 * 3600 * 1000;

class RpcError extends Error {
  constructor(code, text, data) { super(text); this.code = code; this.data = data; }
}
const err = (code, text, data) => new RpcError(code, text, data);

const E = {
  auth: () => err(-32504, "Ruxsat yo'q"),
  noOrder: () => err(-31050, 'Buyurtma topilmadi', 'order_id'),
  badAmount: () => err(-31001, "Noto'g'ri summa"),
  cantDo: () => err(-31008, "Amalni bajarib bo'lmaydi"),
  noTx: () => err(-31003, 'Tranzaksiya topilmadi'),
  busy: () => err(-31099, "Buyurtma band: boshqa tranzaksiya kutilmoqda", 'order_id'),
  cantCancel: () => err(-31007, "Buyurtma bajarilgan, bekor qilib bo'lmaydi"),
};

async function loadOrder(params) {
  const id = params && params.account && params.account.order_id;
  if (!id) throw E.noOrder();
  const order = await store().get(`orders/${String(id)}`);
  if (!order) throw E.noOrder();
  return { id: String(id), order };
}

async function checkPerform(params) {
  const { id, order } = await loadOrder(params);
  if (order.status !== 'new') throw E.cantDo();
  if (Number(params.amount) !== order.amount * 100) throw E.badAmount();
  return { id, order };
}

const view = (tx) => ({
  create_time: tx.create_time, perform_time: tx.perform_time, cancel_time: tx.cancel_time,
  transaction: tx.id, state: tx.state, reason: tx.reason,
});

async function expireIfNeeded(tx) {
  if (tx.state === 1 && Date.now() - tx.create_time > TIMEOUT) {
    const upd = { state: -1, reason: 4, cancel_time: Date.now() };
    await store().update(`paymeTx/${tx.id}`, upd);
    await store().update(`orders/${tx.order_id}`, { paymeTx: null });
    Object.assign(tx, upd);
    return true;
  }
  return false;
}

const methods = {
  async CheckPerformTransaction(params) {
    await checkPerform(params);
    return { allow: true };
  },

  async CreateTransaction(params) {
    const s = store();
    const existing = await s.get(`paymeTx/${params.id}`);
    if (existing) {
      if (await expireIfNeeded(existing)) throw E.cantDo();
      if (existing.state !== 1) throw E.cantDo();
      return { create_time: existing.create_time, transaction: existing.id, state: 1 };
    }
    const { id: orderId, order } = await checkPerform(params);
    if (order.paymeTx && order.paymeTx !== params.id) {
      const other = await s.get(`paymeTx/${order.paymeTx}`);
      if (other && !(await expireIfNeeded(other)) && other.state === 1) throw E.busy();
    }
    const tx = {
      id: params.id, time: params.time, amount: Number(params.amount), order_id: orderId,
      create_time: Date.now(), perform_time: 0, cancel_time: 0, state: 1, reason: null,
    };
    await s.set(`paymeTx/${tx.id}`, tx);
    await s.update(`orders/${orderId}`, { paymeTx: tx.id });
    return { create_time: tx.create_time, transaction: tx.id, state: 1 };
  },

  async PerformTransaction(params) {
    const s = store();
    const tx = await s.get(`paymeTx/${params.id}`);
    if (!tx) throw E.noTx();
    if (tx.state === 2) return { transaction: tx.id, perform_time: tx.perform_time, state: 2 };
    if (tx.state !== 1) throw E.cantDo();
    if (await expireIfNeeded(tx)) throw E.cantDo();
    if (!(await markPaid(tx.order_id, 'payme'))) throw E.cantDo();
    const perform_time = Date.now();
    await s.update(`paymeTx/${tx.id}`, { state: 2, perform_time });
    return { transaction: tx.id, perform_time, state: 2 };
  },

  async CancelTransaction(params) {
    const s = store();
    const tx = await s.get(`paymeTx/${params.id}`);
    if (!tx) throw E.noTx();
    if (tx.state === -1 || tx.state === -2) return { transaction: tx.id, cancel_time: tx.cancel_time, state: tx.state };
    const cancel_time = Date.now();
    if (tx.state === 1) {
      await s.update(`paymeTx/${tx.id}`, { state: -1, reason: params.reason, cancel_time });
      await s.update(`orders/${tx.order_id}`, { paymeTx: null }); // to'lanmagan: buyurtma 'new' bo'lib qoladi
      return { transaction: tx.id, cancel_time, state: -1 };
    }
    // state === 2: pul qaytarilmoqda. Fayl allaqachon yuklab olingan bo'lsa bekor qilib bo'lmaydi.
    const order = await s.get(`orders/${tx.order_id}`);
    if (order && order.downloads > 0) throw E.cantCancel();
    await s.update(`paymeTx/${tx.id}`, { state: -2, reason: params.reason, cancel_time });
    await s.update(`orders/${tx.order_id}`, { status: 'revoked' });
    return { transaction: tx.id, cancel_time, state: -2 };
  },

  async CheckTransaction(params) {
    const tx = await store().get(`paymeTx/${params.id}`);
    if (!tx) throw E.noTx();
    return view(tx);
  },

  async GetStatement(params) {
    const all = await store().range('paymeTx', 'create_time', Number(params.from), Number(params.to));
    const transactions = Object.values(all).map((tx) => ({
      id: tx.id, time: tx.time, amount: tx.amount, account: { order_id: tx.order_id }, ...view(tx),
    }));
    return { transactions };
  },
};

module.exports = async (req, res) => {
  const body = req.body || {};
  const respond = (payload) => res.status(200).json({ jsonrpc: '2.0', id: body.id === undefined ? null : body.id, ...payload });
  const fail = (e) => respond({
    error: { code: e.code, message: { uz: e.message, ru: e.message, en: e.message }, data: e.data },
  });

  try {
    const expected = 'Basic ' + Buffer.from(`Paycom:${process.env.PAYME_KEY}`).toString('base64');
    if (!safeEqual(req.headers.authorization || '', expected)) return fail(E.auth());
    const fn = methods[body.method];
    if (!fn) return fail(err(-32601, 'Method not found', body.method));
    return respond({ result: await fn(body.params || {}) });
  } catch (e) {
    if (e instanceof RpcError) return fail(e);
    console.error('payme error', e);
    return fail(err(-32400, 'Ichki xatolik'));
  }
};
