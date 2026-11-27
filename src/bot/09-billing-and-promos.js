const TG_NEXUS_PRO_DAY_MS = 24 * 60 * 60 * 1000;
const TG_NEXUS_PRO_TRIAL_DAYS = 12;
const TG_NEXUS_PRO_DEFAULT_PLANS = Object.freeze({
  7: { days: 7, stars: 49 },
  14: { days: 14, stars: 89 },
  21: { days: 21, stars: 119 },
  30: { days: 30, stars: 149 }
});
function readProPlanPrice(days, fallback) {
  const key = 'PRO_PRICE_' + days + '_DAYS';
  const configured = options.proPlanPrices && options.proPlanPrices[days] != null
    ? options.proPlanPrices[days]
    : process.env[key];
  if (configured == null || String(configured).trim() === '') return fallback;
  const amount = Number(configured);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000) {
    throw new Error(key + ' must be a whole number between 1 and 100000.');
  }
  return amount;
}
const TG_NEXUS_PRO_PLANS = Object.freeze(Object.fromEntries(
  Object.values(TG_NEXUS_PRO_DEFAULT_PLANS).map((plan) => [
    plan.days,
    Object.freeze({
      days: plan.days,
      stars: readProPlanPrice(plan.days, plan.stars)
    })
  ])
));
const TG_NEXUS_BILLING_SUPPORT_URL = 'https://t.me/TG_Nexus_official';
const proCheckoutReservations = new Map();
const proRefundReservations = new Set();

function normalizeProState(user) {
  if (!user.pro || typeof user.pro !== 'object' || Array.isArray(user.pro)) user.pro = {};
  const pro = user.pro;
  if (!Number.isFinite(Number(pro.expiresAt))) pro.expiresAt = 0;
  if (!Array.isArray(pro.payments)) pro.payments = [];
  if (!Array.isArray(pro.promoRedemptions)) pro.promoRedemptions = [];
  if (!Array.isArray(user.pendingStarPayments)) user.pendingStarPayments = [];
  return pro;
}

function isProBillingEnabled() {
  if (typeof options.proBillingEnabled === 'boolean') return options.proBillingEnabled;
  return String(process.env.PRO_BILLING_ENABLED || '').trim().toLowerCase() === 'true';
}

function ensureProTrial(userId, now = Date.now()) {
  const user = store.getUser(userId);
  const pro = normalizeProState(user);
  if (Number(pro.trialStartedAt) > 0) return getProStatus(userId, now);
  const previous = {
    trialStartedAt: pro.trialStartedAt,
    trialExpiresAt: pro.trialExpiresAt,
    expiresAt: pro.expiresAt
  };
  pro.trialStartedAt = now;
  pro.trialExpiresAt = now + TG_NEXUS_PRO_TRIAL_DAYS * TG_NEXUS_PRO_DAY_MS;
  pro.expiresAt = Math.max(now, Number(pro.expiresAt) || 0) +
    TG_NEXUS_PRO_TRIAL_DAYS * TG_NEXUS_PRO_DAY_MS;
  try {
    store.save();
  } catch (error) {
    if (previous.trialStartedAt === undefined) delete pro.trialStartedAt;
    else pro.trialStartedAt = previous.trialStartedAt;
    if (previous.trialExpiresAt === undefined) delete pro.trialExpiresAt;
    else pro.trialExpiresAt = previous.trialExpiresAt;
    if (previous.expiresAt === undefined) delete pro.expiresAt;
    else pro.expiresAt = previous.expiresAt;
    throw error;
  }
  return getProStatus(userId, now);
}

function getProStatus(userId, now = Date.now()) {
  const user = store.getUser(userId);
  const pro = normalizeProState(user);
  const expiresAt = Math.max(0, Number(pro.expiresAt) || 0);
  const trialExpiresAt = Math.max(0, Number(pro.trialExpiresAt) || 0);
  const payments = pro.payments;
  const promoRedemptions = pro.promoRedemptions;
  const active = expiresAt > now;
  const trialActive = active && trialExpiresAt > now &&
    payments.length === 0 && promoRedemptions.length === 0;
  return {
    active,
    expiresAt,
    remainingDays: active ? Math.ceil((expiresAt - now) / TG_NEXUS_PRO_DAY_MS) : 0,
    trialStartedAt: Number(pro.trialStartedAt) || 0,
    trialExpiresAt,
    trialActive,
    hasPaidPayments: payments.length > 0,
    hasPromoRedemptions: promoRedemptions.length > 0
  };
}

function formatProDate(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return 'не указана';
  return new Date(Number(timestamp)).toLocaleString('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function isBillingAdmin(userId) {
  const configured = String(options.adminIds == null ? (process.env.BOT_ADMIN_IDS || '') : options.adminIds);
  return configured.split(',').map((item) => item.trim()).filter(Boolean)
    .includes(String(userId));
}

const TG_NEXUS_FREE_PROMPT_LIMIT = 2_000;
const TG_NEXUS_FREE_LIMITS = Object.freeze({
  maxTokens: 1_200, maxRequestTimeoutSeconds: 120,
  maxSystemPromptLength: TG_NEXUS_FREE_PROMPT_LIMIT,
  maxProviderProfiles: 1, maxAgents: 1, maxSandboxTimeoutSeconds: 60,
  reasoning: Object.freeze(['auto']),
  internetSearch: false, sandbox: false, sandboxInternet: false, multiAgent: false
});

function hasProAccess(userId) {
  return isBillingAdmin(userId) || getProStatus(userId).active;
}

function getPlanInfo(userId) {
  const admin = isBillingAdmin(userId);
  const status = getProStatus(userId);
  const active = admin || status.active;
  return {
    tier: active ? 'pro' : 'free', admin, active: status.active,
    trialActive: status.trialActive, expiresAt: status.expiresAt,
    remainingDays: status.remainingDays,
    limits: active ? {
      maxTokens: 32_000, maxRequestTimeoutSeconds: 7_200,
      maxSystemPromptLength: 20_000, maxProviderProfiles: 30,
      maxAgents: 20, maxSandboxTimeoutSeconds: 3_600,
      reasoning: ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      internetSearch: true, sandbox: true, sandboxInternet: true, multiAgent: true
    } : TG_NEXUS_FREE_LIMITS
  };
}

function getEffectiveUserSettings(userId, settings = {}) {
  const effective = Object.assign({}, settings || {});
  if (hasProAccess(userId)) return effective;
  effective.maxTokens = Math.min(1_200, Math.max(1, Math.round(Number(effective.maxTokens) || 1_200)));
  effective.reasoning = 'auto';
  effective.requestTimeoutSeconds = Math.min(120, Math.max(10, Math.round(Number(effective.requestTimeoutSeconds) || 120)));
  if (typeof effective.systemPrompt === 'string') effective.systemPrompt = effective.systemPrompt.slice(0, 2_000);
  effective.internetSearch = false;
  effective.sandbox = false;
  effective.sandboxInternet = false;
  effective.multiAgent = false;
  effective.agentCount = 1;
  effective.sandboxTimeout = 60;
  return effective;
}

function proPlanDurationLabel(days) {
  return days === 21 ? '21 день' : days + ' дней';
}

async function sendProMenu(chatId, userId) {
  const status = getProStatus(userId);
  const lines = [
    '<b>TG Nexus PRO</b>',
    '',
    'Бесплатный пробный период: 12 дней на один Telegram-аккаунт.',
    status.active
      ? 'Доступ активен: до ' + formatProDate(status.expiresAt) +
        ' (ещё ' + status.remainingDays + ' дн.).'
      : 'Активного PRO-доступа сейчас нет.',
    '',
    'Тарифы:',
    ...Object.values(TG_NEXUS_PRO_PLANS).map((plan) =>
      '• ' + proPlanDurationLabel(plan.days) + ' — ' + plan.stars + ' ⭐'),
    '',
    'Покупки разовые: автоматического списания нет.',
    'Новые дни добавляются к текущему сроку доступа.',
    'Расходы на API-провайдеров оплачиваются отдельно.'
  ];
  const optionsForMenu = { parse_mode: 'HTML' };
  if (isProBillingEnabled()) {
    optionsForMenu.reply_markup = {
      inline_keyboard: [
        Object.values(TG_NEXUS_PRO_PLANS).slice(0, 2).map((plan) => ({
          text: proPlanDurationLabel(plan.days) + ' · ' + plan.stars + ' ⭐',
          callback_data: 'pro:buy:' + plan.days
        })),
        Object.values(TG_NEXUS_PRO_PLANS).slice(2).map((plan) => ({
          text: proPlanDurationLabel(plan.days) + ' · ' + plan.stars + ' ⭐',
          callback_data: 'pro:buy:' + plan.days
        }))
      ]
    };
  } else {
    lines.push('', 'Оплата пока отключена и не принимает Stars.');
  }
  await sendTelegramMessage(chatId, lines.join('\n'), optionsForMenu);
}

async function sendProStatus(chatId, userId) {
  const status = getProStatus(userId);
  const user = store.getUser(userId);
  const pro = normalizeProState(user);
  const lines = ['<b>Ваш TG Nexus PRO</b>', ''];
  if (status.active) {
    lines.push('Статус: активен', 'Действует до: ' + formatProDate(status.expiresAt),
      'Осталось: ' + status.remainingDays + ' дн.');
    if (status.trialActive) lines.push('Это ваш бесплатный 12-дневный период.');
  } else {
    lines.push('Статус: не активен', 'Используйте /pro, чтобы посмотреть тарифы.');
  }
  if (pro.payments.length) {
    lines.push('', '<b>Последние покупки:</b>');
    pro.payments.slice(-5).reverse().forEach((payment) => {
      const statusLabel = payment.refundedAt ? ' · возврат' : '';
      lines.push('• ' + payment.days + ' дн. · ' + payment.amount + ' ⭐' + statusLabel + ' · ' +
        formatProDate(payment.paidAt));
    });
  }
  if (pro.promoRedemptions.length) {
    lines.push('', 'Активировано промокодов: ' + pro.promoRedemptions.length + '.');
  }
  await sendTelegramMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function createProInvoice(chatId, userId, days) {
  const plan = TG_NEXUS_PRO_PLANS[Number(days)];
  if (!plan) throw new Error('Unknown PRO plan.');
  if (!isProBillingEnabled()) throw new Error('PRO billing is not enabled.');

  const user = store.getUser(userId);
  normalizeProState(user);
  const now = Date.now();
  user.pendingStarPayments = user.pendingStarPayments
    .filter((item) => item && Number(item.expiresAt) > now)
    .slice(-10);
  const payload = 'tgnexuspro1_' + crypto.randomBytes(18).toString('hex');
  user.pendingStarPayments.push({
    payload,
    days: plan.days,
    amount: plan.stars,
    currency: 'XTR',
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000
  });
  store.save();

  try {
    await telegramRequest('sendInvoice', {
      chat_id: chatId,
      title: 'TG Nexus PRO',
      description: 'Доступ к TG Nexus PRO на ' + plan.days + ' дней.',
      payload,
      currency: 'XTR',
      prices: [{ label: 'TG Nexus PRO · ' + plan.days + ' дней', amount: plan.stars }]
    });
  } catch (error) {
    user.pendingStarPayments = user.pendingStarPayments.filter((item) => item.payload !== payload);
    store.save();
    throw error;
  }
  return { payload, days: plan.days, amount: plan.stars };
}

async function handleProCallback(query, user) {
  const match = String(query.data || '').match(/^pro:buy:(7|14|21|30)$/);
  if (!match) {
    await safeAnswerCallback(query.id, 'Эта кнопка тарифа устарела. Откройте /pro ещё раз.');
    return true;
  }
  if (!isProBillingEnabled()) {
    await safeAnswerCallback(query.id, 'Оплата пока отключена.');
    return true;
  }
  try {
    await createProInvoice(query.message.chat.id, query.from.id, Number(match[1]));
    await safeAnswerCallback(query.id, 'Счёт отправлен. Завершите оплату в Telegram.');
  } catch {
    await safeAnswerCallback(query.id, 'Не удалось создать счёт. Попробуйте позже или обратитесь в /paysupport.');
  }
  return true;
}

async function handlePreCheckoutQuery(query) {
  const queryId = String(query && query.id || '');
  const userId = query && query.from && query.from.id;
  const payload = String(query && query.invoice_payload || '');
  let valid = false;
  let user = null;
  let pending = null;
  let errorMessage = 'Счёт недействителен или устарел. Откройте /pro и создайте новый.';

  if (queryId && userId != null && payload && isProBillingEnabled()) {
    user = store.getUser(userId);
    normalizeProState(user);
    pending = user.pendingStarPayments.find((item) => item && item.payload === payload) || null;
    const now = Date.now();
    const reserved = proCheckoutReservations.get(String(userId));
    const reservedStillActive = reserved && reserved.expiresAt > now;
    const termsAccepted = user.termsAcceptedVersion === REQUIRED_TERMS_VERSION;
    const fresh = pending && Number(pending.expiresAt) > now;
    const correctAmount = pending && query.currency === 'XTR' &&
      Number(query.total_amount) === Number(pending.amount);
    const notReservedForAnotherInvoice = !reservedStillActive || reserved.payload === payload;

    valid = Boolean(termsAccepted && fresh && correctAmount && notReservedForAnotherInvoice);
    if (!termsAccepted) errorMessage = 'Сначала примите актуальные Terms of Service через /start.';
    else if (reservedStillActive && reserved.payload !== payload) {
      errorMessage = 'У вас уже есть оплата в процессе. Завершите её или попробуйте позже.';
    } else if (fresh && !correctAmount) errorMessage = 'Сумма счёта не совпадает с тарифом.';
  } else if (!isProBillingEnabled()) {
    errorMessage = 'Оплата TG Nexus PRO временно отключена.';
  }

  await telegramRequest('answerPreCheckoutQuery', {
    pre_checkout_query_id: queryId,
    ok: valid,
    ...(!valid ? { error_message: errorMessage } : {})
  }, { timeoutMs: 8_000 });

  if (valid) {
    proCheckoutReservations.set(String(userId), {
      payload,
      expiresAt: Date.now() + 15 * 60 * 1000
    });
  }
  return valid;
}

async function handleSuccessfulPayment(message) {
  const userId = message && message.from && message.from.id;
  const chatId = message && message.chat && message.chat.id;
  const payment = message && message.successful_payment;
  if (userId == null || chatId == null || !payment) return false;

  const user = store.getUser(userId);
  const pro = normalizeProState(user);
  const chargeId = String(payment.telegram_payment_charge_id || '');
  const alreadyApplied = chargeId && pro.payments.some((item) =>
    item && item.telegramPaymentChargeId === chargeId);
  if (alreadyApplied) {
    await sendText(chatId, 'Эта оплата уже была учтена. Статус: /mypro');
    return true;
  }

  const payload = String(payment.invoice_payload || '');
  const pendingIndex = user.pendingStarPayments.findIndex((item) =>
    item && item.payload === payload);
  const pending = pendingIndex >= 0 ? user.pendingStarPayments[pendingIndex] : null;
  if (!pending || payment.currency !== 'XTR' ||
      Number(payment.total_amount) !== Number(pending.amount) || !chargeId) {
    await sendText(chatId,
      'Платёж получен, но не удалось сопоставить его с тарифом. Не оплачивайте повторно; обратитесь в /paysupport.');
    return true;
  }

  const now = Date.now();
  const previousExpiry = Number(pro.expiresAt) || 0;
  const previousPayments = pro.payments.slice();
  const previousPending = user.pendingStarPayments.slice();
  const baseExpiry = Math.max(now, previousExpiry);
  const nextExpiry = baseExpiry + Number(pending.days) * TG_NEXUS_PRO_DAY_MS;
  pro.expiresAt = nextExpiry;
  pro.payments.push({
    telegramPaymentChargeId: chargeId,
    amount: Number(pending.amount),
    currency: 'XTR',
    days: Number(pending.days),
    paidAt: now,
    expiresAt: nextExpiry
  });
  if (pro.payments.length > 100) pro.payments.splice(0, pro.payments.length - 100);
  user.pendingStarPayments = [];
  try {
    store.save();
  } catch (error) {
    pro.expiresAt = previousExpiry;
    pro.payments = previousPayments;
    user.pendingStarPayments = previousPending;
    throw error;
  }
  proCheckoutReservations.delete(String(userId));

  await sendText(chatId, [
    'TG Nexus PRO активирован!',
    'Добавлено: ' + pending.days + ' дней.',
    'Доступ действует до: ' + formatProDate(nextExpiry),
    'Текущий статус: /mypro'
  ].join('\n'));
  return true;
}


async function handleProRefundCommand(chatId, actorId, args) {
  if (!isBillingAdmin(actorId)) {
    await sendText(chatId, 'Эта команда доступна только администратору.');
    return true;
  }

  const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3 || parts[2] !== 'CONFIRM') {
    await sendText(chatId,
      'Использование: /refund USER_ID CHARGE_ID CONFIRM\n' +
      'Команда возвращает Stars и отменяет купленные дни PRO. Сначала проверьте пользователя и платёж.');
    return true;
  }

  const targetId = parts[0];
  const numericUserId = Number(targetId);
  const chargeId = parts[1];
  if (!/^\d{1,24}$/.test(targetId) || !Number.isSafeInteger(numericUserId) ||
      numericUserId <= 0 || chargeId.length < 8 || chargeId.length > 256 ||
      /\s/.test(chargeId)) {
    await sendText(chatId, 'Некорректный Telegram ID или идентификатор платежа.');
    return true;
  }

  const lockKey = targetId + ':' + chargeId;
  if (proRefundReservations.has(lockKey)) {
    await sendText(chatId, 'Возврат этого платежа уже выполняется.');
    return true;
  }

  if (!store.getAdminUser(targetId)) {
    await sendText(chatId, 'Пользователь не найден.');
    return true;
  }
  const target = store.getUser(targetId);
  const pro = normalizeProState(target);
  const payment = pro.payments.find((item) =>
    item && item.telegramPaymentChargeId === chargeId);
  if (!payment) {
    await sendText(chatId, 'Платёж не найден в истории TG Nexus этого пользователя.');
    return true;
  }
  if (payment.refundedAt) {
    await sendText(chatId, 'Этот платёж уже отмечен как возвращённый. Повторный возврат не требуется.');
    return true;
  }
  const days = Number(payment.days);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    await sendText(chatId, 'У платежа некорректно записан срок. Нужна ручная проверка.');
    return true;
  }

  proRefundReservations.add(lockKey);
  try {
    if (!payment.refundPendingAt) {
      payment.refundPendingAt = Date.now();
      store.save();
    }

    let alreadyRefunded = false;
    try {
      await telegramRequest('refundStarPayment', {
        user_id: numericUserId,
        telegram_payment_charge_id: chargeId
      });
    } catch (error) {
      const description = String(error && (error.telegramDescription || error.message) || '');
      if (!/CHARGE_ALREADY_REFUNDED/i.test(description)) {
        await sendText(chatId,
          'Telegram не подтвердил возврат. Запись оставлена для безопасной повторной проверки; попробуйте позже.');
        return true;
      }
      alreadyRefunded = true;
    }

    const previousExpiry = Number(pro.expiresAt) || 0;
    const previousRefundedAt = payment.refundedAt;
    const previousStatus = payment.refundStatus;
    const previousRevokedAt = payment.accessRevokedAt;
    const now = Date.now();
    pro.expiresAt = Math.max(0, previousExpiry - days * TG_NEXUS_PRO_DAY_MS);
    payment.refundedAt = now;
    payment.refundStatus = 'refunded';
    payment.accessRevokedAt = now;

    try {
      store.save();
    } catch (error) {
      pro.expiresAt = previousExpiry;
      if (previousRefundedAt === undefined) delete payment.refundedAt;
      else payment.refundedAt = previousRefundedAt;
      if (previousStatus === undefined) delete payment.refundStatus;
      else payment.refundStatus = previousStatus;
      if (previousRevokedAt === undefined) delete payment.accessRevokedAt;
      else payment.accessRevokedAt = previousRevokedAt;
      throw error;
    }

    proCheckoutReservations.delete(targetId);
    try {
      store.appendAdminLog({
        actorId,
        action: 'pro_refund',
        summary: 'Возврат Stars для Telegram ID ' + targetId + ': ' + days + ' дн.'
      });
    } catch {}

    try {
      await sendText(numericUserId,
        'Возврат ' + payment.amount + ' ⭐ за TG Nexus PRO выполнен. Купленный срок ' +
        days + ' дн. отменён.');
    } catch {}

    await sendText(chatId,
      'Возврат выполнен и сохранён.' + (alreadyRefunded
        ? ' Telegram сообщил, что платёж уже был возвращён ранее.'
        : '') + '\nПользователь: ' + targetId +
      '\nСумма: ' + payment.amount + ' ⭐' +
      '\nОтменено дней PRO: ' + days + '.');
    return true;
  } finally {
    proRefundReservations.delete(lockKey);
  }
}


async function handlePromoCreateCommand(chatId, userId, args) {
  if (!isBillingAdmin(userId)) {
    await sendText(chatId, 'Эта команда доступна только администратору.');
    return true;
  }
  const parts = String(args || '').trim().split(/\s+/);
  const code = parts[0] || '';
  const days = Number(parts[1]);
  const maxUses = parts[2] === undefined ? 1 : Number(parts[2]);
  const result = store.createPromoCode(code, { days, maxUses, createdBy: userId });
  if (!result.ok) {
    const messages = {
      invalid_code: 'Код: 4–32 символа A–Z, 0–9, _ или -.',
      invalid_days: 'Количество дней должно быть от 1 до 365.',
      invalid_limit: 'Лимит должен быть от 0 до 100000; 0 означает без лимита.',
      exists: 'Такой промокод уже существует.'
    };
    await sendText(chatId, messages[result.reason] || 'Не удалось создать промокод.');
    return true;
  }
  await sendText(chatId, 'Промокод ' + result.code + ' создан: ' + result.days +
    ' дней, использований: ' + (result.maxUses === 0 ? 'без лимита' : result.maxUses) + '.');
  return true;
}

async function handlePromoDisableCommand(chatId, userId, args) {
  if (!isBillingAdmin(userId)) {
    await sendText(chatId, 'Эта команда доступна только администратору.');
    return true;
  }
  const code = String(args || '').trim();
  if (!code) {
    await sendText(chatId, 'Использование: /promo_disable CODE');
    return true;
  }
  await sendText(chatId, store.disablePromoCode(code)
    ? 'Промокод отключён.'
    : 'Промокод не найден.');
  return true;
}

async function handlePromoListCommand(chatId, userId) {
  if (!isBillingAdmin(userId)) {
    await sendText(chatId, 'Эта команда доступна только администратору.');
    return true;
  }
  const list = store.listPromoCodes().slice(-30);
  if (!list.length) {
    await sendText(chatId, 'Промокодов пока нет.');
    return true;
  }
  await sendText(chatId, list.map((item) =>
    item.code + ' — ' + item.days + ' дн. · ' +
    (item.enabled ? 'активен' : 'отключён') + ' · ' +
    item.uses + '/' + (item.maxUses || '∞')
  ).join('\n'));
  return true;
}
