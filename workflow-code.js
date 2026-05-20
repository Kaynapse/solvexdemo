import { workflow, node, trigger, sticky, ifElse, languageModel, memory, expr, nodeJson } from '@n8n/workflow-sdk';

// =====================================================================
// Trigger + Normalize
// =====================================================================
const chatWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Chat Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'chat-demo',
      responseMode: 'responseNode',
      options: { allowedOrigins: '*' }
    },
    position: [240, 400]
  },
  output: [{
    body: {
      sessionId: 's_demo123',
      message: 'שלום',
      mode: 'chatbot',
      businessName: 'מספרת דני',
      businessType: 'מספרה',
      systemPrompt: '',
      ownerPhone: '+972501234567',
      faqs: []
    }
  }]
});

const normalizeInput = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Normalize Input',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'session-id', name: 'sessionId', value: expr('{{ $json.body?.sessionId ?? $json.sessionId ?? "anon" }}'), type: 'string' },
          { id: 'message', name: 'message', value: expr('{{ $json.body?.message ?? $json.message ?? "" }}'), type: 'string' },
          { id: 'mode', name: 'mode', value: expr('{{ $json.body?.mode ?? $json.mode ?? "agent" }}'), type: 'string' },
          { id: 'business-name', name: 'businessName', value: expr('{{ $json.body?.businessName ?? $json.businessName ?? "העסק שלנו" }}'), type: 'string' },
          { id: 'business-type', name: 'businessType', value: expr('{{ $json.body?.businessType ?? $json.businessType ?? "עסק קטן" }}'), type: 'string' },
          { id: 'system-prompt', name: 'systemPromptOverride', value: expr('{{ $json.body?.systemPrompt ?? $json.systemPrompt ?? "" }}'), type: 'string' },
          { id: 'owner-phone', name: 'ownerPhone', value: expr('{{ $json.body?.ownerPhone ?? $json.ownerPhone ?? "" }}'), type: 'string' },
          { id: 'faqs', name: 'faqs', value: expr('{{ $json.body?.faqs ?? $json.faqs ?? [] }}'), type: 'array' }
        ]
      },
      options: {}
    },
    position: [464, 400]
  },
  output: [{
    sessionId: 's_demo123',
    message: 'שלום',
    mode: 'chatbot',
    businessName: 'מספרת דני',
    businessType: 'מספרה',
    systemPromptOverride: '',
    ownerPhone: '+972501234567',
    faqs: []
  }]
});

// =====================================================================
// Top-level routing: Chatbot vs Agent
// =====================================================================
const isChatbotMode = ifElse({
  version: 2.3,
  config: {
    name: 'Is Chatbot Mode?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.mode }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'chatbot' }],
        combinator: 'and'
      }
    },
    position: [688, 400]
  }
});

// =====================================================================
// CHATBOT BRANCH: FAQ Router (state machine + FAQ matching)
// =====================================================================
const faqRouter = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'FAQ Router',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: 'const data = $input.first().json;\nconst sessionId = data.sessionId || "anon";\nconst message = String(data.message || "").trim();\nconst lower = message.toLowerCase();\n\nconst staticData = $getWorkflowStaticData("global");\nif (!staticData.bookingStates) staticData.bookingStates = {};\nlet state = staticData.bookingStates[sessionId] || { step: "idle", data: {} };\n\nconst services = [\n  { id: 1, name: "תספורת", duration: 30, priceILS: 80 },\n  { id: 2, name: "צבע ותספורת", duration: 75, priceILS: 200 },\n  { id: 3, name: "טיפול זקן", duration: 20, priceILS: 50 }\n];\nconst hours = { start: 9, end: 19 };\nconst tzOffset = "+03:00";\n\nconst defaultFaqs = [\n  { keywords: ["שעות","פתוח","סגור","מתי","hours","open"], answer: "השעות שלנו: ראשון-חמישי 9:00-19:00, שישי 9:00-14:00, שבת סגור." },\n  { keywords: ["מחיר","עלות","כמה עולה","תמחור","price","cost","כמה זה"], answer: "תספורת 80 ש\\"ח, צבע ותספורת 200 ש\\"ח, זקן 50 ש\\"ח. רוצים לקבוע תור? כתבו \\"תור\\"." },\n  { keywords: ["כתובת","מיקום","איפה","להגיע","הגעה","address","location"], answer: "רחוב הרצל 50, תל אביב. יש חניה ליד." },\n  { keywords: ["שירות","שירותים","מציעים","services"], answer: "אנחנו מציעים: תספורת, צבע ותספורת, וטיפול זקן. כתבו \\"תור\\" לקביעת תור." },\n  { keywords: ["טלפון","צור קשר","phone","contact"], answer: "אפשר להתקשר אלינו ב-03-1234567 בשעות הפעילות." }\n];\n\nconst customFaqs = Array.isArray(data.faqs) && data.faqs.length ? data.faqs : null;\nconst faqs = customFaqs || defaultFaqs;\n\nconst bookingTriggers = ["תור","להזמין","לקבוע","פגישה","book","schedule","appointment"];\nconst cancelTriggers = ["ביטול","בטל","cancel"];\nconst hasAny = (arr) => arr.some(t => lower.includes(t.toLowerCase()));\nconst pad = (n) => String(n).padStart(2, "0");\n\nlet reply = "";\nlet readyToBook = false;\nlet bookingPayload = null;\n\nif (state.step !== "idle" && hasAny(cancelTriggers)) {\n  state = { step: "idle", data: {} };\n  reply = "תהליך התור בוטל. אפשר לשאול שאלות או לכתוב \\"תור\\" להתחיל מחדש.";\n}\nelse if (state.step === "idle") {\n  if (hasAny(bookingTriggers)) {\n    state = { step: "service", data: {} };\n    const list = services.map(s => s.id + ". " + s.name + " — " + s.duration + " דקות, " + s.priceILS + " ש\\"ח").join("\\n");\n    reply = "בשמחה! בחרו שירות (כתבו את המספר):\\n" + list + "\\n\\nלביטול בכל שלב: \\"ביטול\\"";\n  } else {\n    let matched = null;\n    for (const faq of faqs) {\n      for (const kw of (faq.keywords || [])) {\n        if (lower.includes(String(kw).toLowerCase())) { matched = faq.answer; break; }\n      }\n      if (matched) break;\n    }\n    reply = matched || "לא הבנתי. אפשר לשאול על: שעות, מחירים, כתובת, שירותים, או לכתוב \\"תור\\" לקביעת תור.";\n  }\n}\nelse if (state.step === "service") {\n  const num = parseInt(message, 10);\n  const svc = services.find(s => s.id === num);\n  if (svc) {\n    state.data.service = svc;\n    state.step = "datetime";\n    reply = "מצוין, " + svc.name + ".\\nמתי נוח? כתבו תאריך ושעה בפורמט DD/MM HH:MM\\nלדוגמה: 25/12 14:30\\nשעות פעילות: " + hours.start + ":00-" + hours.end + ":00";\n  } else {\n    reply = "אנא בחרו מספר מהרשימה.";\n  }\n}\nelse if (state.step === "datetime") {\n  const m = message.match(/(\\d{1,2})\\/(\\d{1,2})\\s+(\\d{1,2}):(\\d{2})/);\n  if (!m) {\n    reply = "פורמט לא תקין. אנא כתבו תאריך ושעה כך: DD/MM HH:MM (לדוגמה: 25/12 14:30)";\n  } else {\n    const day = parseInt(m[1], 10);\n    const month = parseInt(m[2], 10);\n    const hour = parseInt(m[3], 10);\n    const minute = parseInt(m[4], 10);\n    if (day < 1 || day > 31 || month < 1 || month > 12) {\n      reply = "תאריך לא תקין. אנא נסו שוב.";\n    } else if (hour < hours.start || hour >= hours.end) {\n      reply = "השעה מחוץ לשעות הפעילות (" + hours.start + ":00-" + hours.end + ":00). אנא בחרו שעה אחרת.";\n    } else {\n      const now = new Date();\n      let year = now.getFullYear();\n      let startStr = year + "-" + pad(month) + "-" + pad(day) + "T" + pad(hour) + ":" + pad(minute) + ":00" + tzOffset;\n      let candidate = new Date(startStr);\n      if (isNaN(candidate.getTime())) {\n        reply = "תאריך/שעה לא תקינים. נסו שוב.";\n      } else {\n        if (candidate.getTime() < now.getTime() - 60000) {\n          year += 1;\n          startStr = year + "-" + pad(month) + "-" + pad(day) + "T" + pad(hour) + ":" + pad(minute) + ":00" + tzOffset;\n          candidate = new Date(startStr);\n        }\n        const durMin = state.data.service.duration;\n        const totalMin = hour * 60 + minute + durMin;\n        const endHour = Math.floor(totalMin / 60);\n        const endMinute = totalMin % 60;\n        const endStr = year + "-" + pad(month) + "-" + pad(day) + "T" + pad(endHour) + ":" + pad(endMinute) + ":00" + tzOffset;\n        state.data.startISO = startStr;\n        state.data.endISO = endStr;\n        state.data.startDisplay = pad(day) + "/" + pad(month) + "/" + year + " " + pad(hour) + ":" + pad(minute);\n        state.step = "name";\n        reply = "מצוין. מה השם המלא?";\n      }\n    }\n  }\n}\nelse if (state.step === "name") {\n  if (message.length < 2) {\n    reply = "השם קצר מדי. אנא כתבו שם מלא.";\n  } else {\n    state.data.fullName = message;\n    state.step = "phone";\n    reply = "תודה. מה מספר הטלפון לאישור?";\n  }\n}\nelse if (state.step === "phone") {\n  const clean = message.replace(/[\\s\\-()]/g, "");\n  if (!/^\\+?\\d{7,15}$/.test(clean)) {\n    reply = "מספר טלפון לא תקין. אנא כתבו מספר כמו 0501234567.";\n  } else {\n    state.data.phone = clean;\n    state.step = "confirm";\n    reply = "סיכום התור:\\nשירות: " + state.data.service.name + "\\nתאריך: " + state.data.startDisplay + "\\nשם: " + state.data.fullName + "\\nטלפון: " + state.data.phone + "\\n\\nלאשר? (כן/לא)";\n  }\n}\nelse if (state.step === "confirm") {\n  if (/^(כן|yes|y|אישור|מאשר|מאשרת|אוקיי|ok)/i.test(message)) {\n    readyToBook = true;\n    bookingPayload = {\n      service: state.data.service,\n      startISO: state.data.startISO,\n      endISO: state.data.endISO,\n      startDisplay: state.data.startDisplay,\n      fullName: state.data.fullName,\n      phone: state.data.phone,\n      ownerPhone: data.ownerPhone || "",\n      businessName: data.businessName || ""\n    };\n    state = { step: "idle", data: {} };\n    reply = "";\n  } else if (/^(לא|no|n|ביטול)/i.test(message)) {\n    state = { step: "idle", data: {} };\n    reply = "בוטל. אפשר להתחיל מחדש כשתרצו.";\n  } else {\n    reply = "אנא ענו \\"כן\\" לאישור או \\"לא\\" לביטול.";\n  }\n}\n\nstaticData.bookingStates[sessionId] = state;\n\nreturn [{ json: { reply, mode: "chatbot", readyToBook, booking: bookingPayload, sessionId } }];'
    },
    position: [912, 256]
  },
  output: [{
    reply: '',
    mode: 'chatbot',
    readyToBook: true,
    booking: {
      service: { id: 1, name: 'תספורת', duration: 30, priceILS: 80 },
      startISO: '2026-05-25T14:30:00+03:00',
      endISO: '2026-05-25T15:00:00+03:00',
      startDisplay: '25/05/2026 14:30',
      fullName: 'דני כהן',
      phone: '0501234567',
      ownerPhone: '+972501234567',
      businessName: 'מספרת דני'
    },
    sessionId: 's_demo123'
  }]
});

// IF: Is the booking confirmed and ready to write to calendar?
const isReadyToBook = ifElse({
  version: 2.3,
  config: {
    name: 'Is Ready to Book?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.readyToBook }}'), operator: { type: 'boolean', operation: 'true' }, rightValue: '' }],
        combinator: 'and'
      }
    },
    position: [1120, 256]
  }
});

const respondChatbotPlain = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Chatbot (Plain)',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ reply: $json.reply, mode: "chatbot" }) }}'),
      options: {
        responseHeaders: { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }] }
      }
    },
    position: [1344, 144]
  },
  output: [{}]
});

// =====================================================================
// SCHEDULING BRANCH: Availability check → create event → notify owner
// =====================================================================
const checkAvailability = node({
  type: 'n8n-nodes-base.googleCalendar',
  version: 1.3,
  config: {
    name: 'Check Calendar Availability',
    parameters: {
      resource: 'calendar',
      operation: 'availability',
      calendar: { __rl: true, mode: 'list', value: 'primary', cachedResultName: 'primary' },
      timeMin: expr('{{ $json.booking.startISO }}'),
      timeMax: expr('{{ $json.booking.endISO }}'),
      options: { outputFormat: 'availability' }
    },
    credentials: { googleCalendarOAuth2Api: { id: 'iTHzzkfDNzGD6LnW', name: 'Google Calendar account' } },
    position: [1344, 368]
  },
  output: [{ available: true }]
});

const isSlotFree = ifElse({
  version: 2.3,
  config: {
    name: 'Is Slot Free?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.available }}'), operator: { type: 'boolean', operation: 'true' }, rightValue: '' }],
        combinator: 'and'
      }
    },
    position: [1552, 368]
  }
});

const createEvent = node({
  type: 'n8n-nodes-base.googleCalendar',
  version: 1.3,
  config: {
    name: 'Create Calendar Event',
    parameters: {
      resource: 'event',
      operation: 'create',
      calendar: { __rl: true, mode: 'list', value: 'primary', cachedResultName: 'primary' },
      start: expr('{{ $(\'FAQ Router\').item.json.booking.startISO }}'),
      end: expr('{{ $(\'FAQ Router\').item.json.booking.endISO }}'),
      useDefaultReminders: true,
      additionalFields: {
        summary: expr('{{ $(\'FAQ Router\').item.json.booking.service.name + " — " + $(\'FAQ Router\').item.json.booking.fullName }}'),
        description: expr('{{ "תור דרך הצ\'אט\\nשירות: " + $(\'FAQ Router\').item.json.booking.service.name + "\\nשם: " + $(\'FAQ Router\').item.json.booking.fullName + "\\nטלפון: " + $(\'FAQ Router\').item.json.booking.phone + "\\nמחיר: " + $(\'FAQ Router\').item.json.booking.service.priceILS + " ש\\"ח" }}')
      }
    },
    credentials: { googleCalendarOAuth2Api: { id: 'iTHzzkfDNzGD6LnW', name: 'Google Calendar account' } },
    position: [1776, 272]
  },
  output: [{ id: 'evt_abc123', htmlLink: 'https://calendar.google.com/event?eid=xxx', status: 'confirmed' }]
});

// FOUNDATION-ONLY: build owner notification summary. Does not send.
// To wire to WhatsApp later: add Meta WhatsApp Cloud node here (or Telegram fallback).
const buildOwnerSummary = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Notify Owner (TODO)',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          {
            id: 'owner-summary',
            name: 'ownerSummary',
            value: expr('{{ "🆕 תור חדש מהצ\'אט\\n\\nעסק: " + $(\'FAQ Router\').item.json.booking.businessName + "\\nשירות: " + $(\'FAQ Router\').item.json.booking.service.name + "\\nתאריך: " + $(\'FAQ Router\').item.json.booking.startDisplay + "\\nשם לקוח: " + $(\'FAQ Router\').item.json.booking.fullName + "\\nטלפון לקוח: " + $(\'FAQ Router\').item.json.booking.phone + "\\nמחיר: " + $(\'FAQ Router\').item.json.booking.service.priceILS + " ש\\"ח\\nלינק ליומן: " + ($json.htmlLink || "n/a") }}'),
            type: 'string'
          },
          {
            id: 'owner-phone',
            name: 'ownerPhone',
            value: expr('{{ $(\'FAQ Router\').item.json.booking.ownerPhone }}'),
            type: 'string'
          },
          {
            id: 'notify-status',
            name: 'notifyStatus',
            value: 'pending_wa_lift',
            type: 'string'
          }
        ]
      },
      options: {}
    },
    position: [2000, 272]
  },
  output: [{ ownerSummary: '🆕 תור חדש מהצ\'אט...', ownerPhone: '+972501234567', notifyStatus: 'pending_wa_lift', id: 'evt_abc123' }]
});

const respondChatbotSuccess = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Chatbot (Booked)',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ reply: "✅ התור נקבע!\\n" + $(\'FAQ Router\').item.json.booking.service.name + " — " + $(\'FAQ Router\').item.json.booking.startDisplay + "\\nשלחנו אישור לבעל העסק. נתראה!", mode: "chatbot" }) }}'),
      options: {
        responseHeaders: { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }] }
      }
    },
    position: [2224, 272]
  },
  output: [{}]
});

const respondChatbotConflict = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Chatbot (Conflict)',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ reply: "מצטערים, השעה " + $(\'FAQ Router\').item.json.booking.startDisplay + " תפוסה. כתבו \\"תור\\" כדי לבחור שעה אחרת.", mode: "chatbot" }) }}'),
      options: {
        responseHeaders: { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }] }
      }
    },
    position: [1776, 480]
  },
  output: [{}]
});

// =====================================================================
// AGENT BRANCH (Groq)
// =====================================================================
const groqModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatGroq',
  version: 1,
  config: {
    name: 'Groq Chat Model',
    parameters: {
      model: 'llama-3.3-70b-versatile',
      options: { temperature: 0.6, maxTokensToSample: 1024 }
    },
    credentials: { groqApi: { id: 'WIo5AM5PmCQztnnV', name: 'Groq account' } },
    position: [880, 704]
  }
});

const conversationMemory = memory({
  type: '@n8n/n8n-nodes-langchain.memoryBufferWindow',
  version: 1.4,
  config: {
    name: 'Conversation Memory',
    parameters: {
      sessionIdType: 'customKey',
      sessionKey: nodeJson(normalizeInput, 'sessionId'),
      contextWindowLength: 20
    },
    position: [1040, 704]
  }
});

const aiAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'AI Agent',
    parameters: {
      promptType: 'define',
      text: expr('{{ $json.message }}'),
      options: {
        systemMessage: expr('You are a friendly customer service AI agent for "{{ $json.businessName }}", a small business in Israel ({{ $json.businessType }}). Respond in Hebrew unless the customer writes in another language - then match their language. Keep replies short, warm, and natural (1-3 sentences). Never invent specific facts (exact prices, real availability, addresses) you were not given. If you do not know something, say "אבדוק את זה ואחזור אליך" and offer to take their details. When a customer wants to book, schedule an appointment, or shows clear buying intent, collect their full name and phone number, then politely tell them the team will confirm the time shortly. Extra business context: {{ $json.systemPromptOverride }}')
      }
    },
    subnodes: { model: groqModel, memory: conversationMemory },
    position: [912, 560]
  },
  output: [{ output: 'בשמחה! איך אפשר לעזור?' }]
});

const respondAgent = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Agent',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ reply: $json.output, mode: "agent" }) }}'),
      options: {
        responseHeaders: { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }] }
      }
    },
    position: [1120, 560]
  },
  output: [{}]
});

// =====================================================================
// Sticky notes
// =====================================================================
const stickyOverview = sticky(
  '## WhatsApp Chat Demo\n\nReceives chat messages from the demo web page and routes to either a rule-based FAQ chatbot (with scheduling) or a Groq-powered AI agent.\n\n**Webhook URL**: copy from the Chat Webhook node into the demo page setup screen.\n\n**Incoming payload**: `{ sessionId, message, mode, businessName, businessType, systemPrompt?, ownerPhone?, faqs? }`\n\n**Response**: `{ reply, mode }`',
  [],
  { color: 4, width: 600, height: 280, position: [96, 16] }
);

const stickyChatbot = sticky(
  '## Chatbot Branch (rule-based + scheduling)\n\nThe FAQ Router is a Code-node state machine that:\n1. Matches FAQ keywords for general questions\n2. Detects "תור" / "schedule" intent and walks the user through: service → date+time → name → phone → confirm\n3. On confirm, emits `readyToBook: true` with full booking details\n\nState is kept in workflow static data, keyed by sessionId.\n\nIf ready, the next branch checks Google Calendar availability and either creates the event + builds owner-notification summary, or replies that the slot is taken.',
  [],
  { color: 5, width: 700, height: 220, position: [848, 16] }
);

const stickyScheduling = sticky(
  '## Scheduling Sub-Flow\n\n**Check Calendar Availability** uses `resource=calendar, operation=availability` against `primary`. Time bounds come from the FAQ Router\'s booking payload.\n\n**Create Calendar Event** writes the booking with the customer name in the title and full details in the description.\n\n**Notify Owner (TODO)** is foundation only. It builds the summary string and stores the owner phone, but does NOT send anything yet — WhatsApp account is restricted. To activate later: add a Meta WhatsApp Cloud node (or Telegram fallback) downstream of this Set node, reading `ownerSummary` and `ownerPhone`.',
  [],
  { color: 5, width: 700, height: 240, position: [1600, 16] }
);

const stickyAgent = sticky(
  '## AI Agent Branch (Groq)\n\nGroq llama-3.3-70b-versatile with sliding-window conversation memory keyed by sessionId. Same session keeps context across messages. New page load = new session = fresh start.\n\nSystem prompt adapts to businessName / businessType from the payload, plus optional systemPrompt override.\n\n**To upgrade to permanent memory** for production: replace the Conversation Memory subnode with a Postgres Chat Memory node (same session key wiring).\n\n**Future**: add Google Calendar tools to the agent so it can book directly via natural conversation.',
  [],
  { color: 6, width: 540, height: 320, position: [1200, 720] }
);

// =====================================================================
// Compose
// =====================================================================
export default workflow('whatsapp-chat-demo', 'WhatsApp Chat Demo')
  .add(stickyOverview)
  .add(stickyChatbot)
  .add(stickyScheduling)
  .add(stickyAgent)
  .add(chatWebhook)
  .to(normalizeInput)
  .to(
    isChatbotMode
      .onTrue(
        faqRouter.to(
          isReadyToBook
            .onFalse(respondChatbotPlain)
            .onTrue(
              checkAvailability.to(
                isSlotFree
                  .onTrue(
                    createEvent
                      .to(buildOwnerSummary)
                      .to(respondChatbotSuccess)
                  )
                  .onFalse(respondChatbotConflict)
              )
            )
        )
      )
      .onFalse(aiAgent.to(respondAgent))
  );
