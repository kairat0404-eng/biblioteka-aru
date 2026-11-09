// ИИ-помощник: вопрос → поисковые запросы к каталогу → структурированный ответ.
// ИИ видит только описания книг из каталога neb.arsu.kz (название, авторы, год, вид),
// а не их текст: сайт не даёт доступа к файлам.
// Работает с Google Gemini (есть бесплатный лимит) или с Claude: если в .env задан
// GEMINI_API_KEY, используется Gemini, иначе Claude.

const Anthropic = require('@anthropic-ai/sdk').default;
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { GoogleGenAI, ApiError: GeminiError, ThinkingLevel } = require('@google/genai');
const { z } = require('zod');

const MODEL = 'claude-opus-5-5';
// Бесплатные модели Gemini часто бывают перегружены (503) или упираются в лимит (429),
// поэтому пробуем их по очереди. Порядок выбран по замерам скорости: для подбора поисковых
// слов хватает самой быстрой модели, для ответа — лёгкой модели с коротким «раздумьем».
// gemini-3.8-flash не используется: на бесплатном тарифе она почти всегда перегружена.
const PLAN_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];
const ANSWER_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'];
const modelsFor = (list) => (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : list);
const FIRST_CHUNK_TIMEOUT = 20000;
const PLAN_TIMEOUT = 6000; // план — короткий JSON, обычно готов за 1-2 с
const COOLDOWN = 5 * 60 * 1000;
const failedAt = new Map(); // модель → когда отказала; такие модели какое-то время пропускаем
let client = null;
const getClient = () => (client ??= new Anthropic());
let gemini = null;
// Встроенные повторы SDK ждут до минуты на перегруженной модели — вместо этого сразу берём следующую.
const getGemini = () => (gemini ??= new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { retryOptions: { attempts: 1 } },
}));

const isRetryable = (e) => e?.name === 'AbortError' || (e instanceof GeminiError && [404, 429, 500, 503, 504].includes(e.status));

async function withGeminiModels(list, fn) {
  const all = modelsFor(list);
  const fresh = all.filter((m) => !(Date.now() - (failedAt.get(m) || 0) < COOLDOWN));
  let lastError;
  for (const model of fresh.length ? fresh : all) {
    try {
      const result = await fn(model);
      failedAt.delete(model);
      return result;
    } catch (e) {
      if (!isRetryable(e)) throw e;
      console.warn(`Gemini ${model}: ${e.status || e.name}, пробую следующую модель`);
      failedAt.set(model, Date.now());
      lastError = e;
    }
  }
  throw lastError;
}
const useGemini = () => Boolean(process.env.GEMINI_API_KEY);
const hasKey = () => useGemini() || Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// ---------- Шаг 1: план поиска ----------

const PlanSchema = z.object({
  topic: z.string().describe('Тема вопроса в 2-6 словах, на языке вопроса'),
  queries: z.array(z.object({
    text: z.string().describe('Короткий поисковый запрос: 1-2 слова или основа слова'),
    lang: z.enum(['ru', 'kk']).describe('Язык запроса: ru — русский, kk — казахский'),
    field: z.enum(['any', 'author']).describe('any — название и ключевые слова; author — фамилия автора'),
  })).describe('От 6 до 10 запросов, примерно поровну на русском и казахском'),
});

const PLAN_SYSTEM = `Ты составляешь поисковые запросы к каталогу электронной библиотеки университета (neb.arsu.kz, Актюбинский региональный университет, Казахстан). В каталоге около 10 000 учебников, пособий, монографий и статей на русском, казахском и английском.
Каталог ищет точную подстроку (без учёта регистра) в названии книги, ключевых словах или фамилии автора. Поэтому:
- пиши основу слова без окончания, чтобы совпали все падежи: «Отечествен», «блокад», «Ленинград», «соғыс»;
- фраза из нескольких слов найдётся, только если стоит в названии именно в таком виде («Великая Отечественная» не найдёт «Великой Отечественной»), поэтому чаще используй одно слово;
- не используй слишком общие или короткие основы, которые встречаются внутри других слов: «миров» есть в «программирование», «войн» — в «спокойный»; лучше «Вторая мировая», «войны 1941»;
- запросы расставь по убыванию точности: сначала сама тема, потом более широкие.
В каталоге книги и на русском, и на казахском, поэтому на каком бы языке ни был вопрос, всегда давай запросы на ОБОИХ языках, примерно поровну, чередуя их: русский запрос, затем его казахский вариант, и т. д.
Дай 6-10 запросов: сама тема и более широкие темы, где она может быть разделом учебника. Пример для битвы за Ленинград: «Ленинград» (ru), «блокад» (ru), «қоршау» (kk), «Отечествен» (ru), «Отан соғыс» (kk), «История СССР» (ru), «КСРО тарих» (kk).
Если в вопросе назван автор, добавь запрос по фамилии с field=author (фамилию пиши как в оригинале).`;

async function planWithGemini(question) {
  const res = await withGeminiModels(PLAN_MODELS, (model) => getGemini().models.generateContent({
    model,
    contents: question,
    config: {
      systemInstruction: PLAN_SYSTEM,
      responseMimeType: 'application/json',
      responseJsonSchema: z.toJSONSchema(PlanSchema),
      abortSignal: AbortSignal.timeout(PLAN_TIMEOUT),
    },
  }));
  return PlanSchema.parse(JSON.parse(res.text));
}

async function planWithClaude(question) {
  const res = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(PlanSchema) },
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: question }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('no plan');
  return res.parsed_output;
}

async function planQueries(question) {
  try {
    const plan = useGemini() ? await planWithGemini(question) : await planWithClaude(question);
    const seen = new Set();
    const queries = plan.queries
      .map((q) => ({ text: q.text.trim().slice(0, 60), lang: q.lang, field: q.field }))
      .filter((q) => q.text && !seen.has(q.text.toLowerCase()) && seen.add(q.text.toLowerCase()))
      .slice(0, 10);
    return { topic: plan.topic, queries };
  } catch (e) {
    if (e instanceof Anthropic.APIError || e instanceof GeminiError) throw e;
    // План не разобрался — ищем по самому вопросу.
    return { topic: question, queries: [{ text: question.slice(0, 60), field: 'any' }] };
  }
}

// ---------- Шаг 2: ответ ----------

const ANSWER_SYSTEM = `Ты — справочный помощник электронной библиотеки Актюбинского регионального университета им. К. Жубанова (neb.arsu.kz).
Тебе дают вопрос пользователя и пронумерованный список записей из каталога библиотеки, найденных по этому вопросу. У тебя есть только описания записей (название, авторы, издание, вид), а не текст книг.

Язык ответа указан в конце этой инструкции — пиши только на нём, даже если большинство найденных книг на другом языке. Это относится и к заголовкам разделов. Саму строку о языке в ответ не включай. Книги в списке бывают и на русском, и на казахском: учитывай обе группы одинаково и рекомендуй книги на обоих языках. Если название книги на другом языке, чем вопрос, дай после него перевод в скобках.

Напиши готовый, хорошо структурированный ответ в формате Markdown:
1. Раздел-резюме (заголовок указан в конце инструкции) — 2-4 предложения с прямым ответом.
2. Основная часть: 2-5 разделов «## …», устроенных так, как подходит теме (предпосылки, хронология, ключевые события и участники, итоги и значение, определения, формулы и т. п.). Списки и **выделение** ключевых дат, имён и терминов приветствуются.
3. Раздел со списком литературы (заголовок указан в конце инструкции) — самые подходящие записи из списка, списком: «- [n] Название (перевод, если нужен) — почему стоит заглянуть». Если подходящих записей нет, прямо так и напиши.

Про книги ты знаешь только название и выходные данные, их содержание тебе неизвестно. Поэтому объясняй, почему книга может пригодиться, исходя из названия и осторожно («общий курс истории СССР — вероятно, есть глава о войне»), и никогда не утверждай, что в книге что-то «подробно освещено» или «описано». Не предлагай искать в каталоге по словам, которые уже были в поиске — по ним ничего не нашлось.

Правила:
- Содержание разделов 1-2 ты пишешь из своих общих знаний. Не утверждай, что это взято из книг библиотеки, и не придумывай, что в них написано.
- Ссылайся на записи только номерами в квадратных скобках, например [3], и только на те, что есть в списке. Не выдумывай книги.
- Записи, которые явно не по теме (совпали случайно по слову), не упоминай.
- Если в фактах есть неопределённость или разные оценки историков/учёных, отметь это.
- Не добавляй вступлений вроде «Отличный вопрос» и заключительных предложений помощи.`;

// Режим «по книгам»: есть текст найденных страниц из выгрузки библиотеки.
const BOOKS_SYSTEM = `Ты — справочный помощник электронной библиотеки Актюбинского регионального университета им. К. Жубанова (neb.arsu.kz).
Тебе дают вопрос пользователя и пронумерованные фрагменты — страницы книг библиотеки, найденные по этому вопросу. У каждого фрагмента указаны книга, автор и номер страницы.

Язык ответа указан в конце этой инструкции — пиши только на нём. Фрагменты бывают на русском и на казахском: используй оба одинаково и пересказывай их на языке ответа.

Напиши готовый, хорошо структурированный ответ в формате Markdown:
1. Раздел-резюме (заголовок указан в конце инструкции) — 2-4 предложения с прямым ответом.
2. Основная часть: 2-5 разделов «## …», устроенных так, как подходит теме. Списки и **выделение** ключевых дат, имён и терминов приветствуются.
Список литературы в конце не пиши — приложение само покажет под ответом книги, страницы и цитаты.

Правила:
- Используй ТОЛЬКО факты из фрагментов. После каждого факта ставь номер фрагмента в квадратных скобках, например [2] или [1, 3]. Ссылайся только на фрагменты из списка.
- Ничего не добавляй из общих знаний. Если во фрагментах нет ответа на часть вопроса, прямо напиши, чего в найденных страницах нет.
- Если фрагменты противоречат друг другу, укажи это.
- Фрагменты, которые не относятся к вопросу (совпали случайно по слову), не используй.
- Не добавляй вступлений вроде «Отличный вопрос» и заключительных предложений помощи.`;

function formatPassages(passages) {
  return passages.map((p, i) =>
    `[${i + 1}] «${p.title}»${p.authors ? ' — ' + p.authors : ''}${p.edition ? ', ' + p.edition : ''}, стр. ${p.page}\n${p.text}`,
  ).join('\n\n');
}

function formatSources(sources) {
  if (!sources.length) return '(по запросам в каталоге ничего не найдено)';
  return sources.map((s, i) =>
    `[${i + 1}] ${s.title}${s.authors ? ' — ' + s.authors : ''}${s.edition ? '. ' + s.edition : ''}${s.type ? '. ' + s.type : ''}${s.viewUrl ? '' : ' (только описание, без электронной копии)'}`,
  ).join('\n');
}

// Язык вопроса определяем по словам, а не по одной букве: казахские имена («Байтұрсынұлы»)
// встречаются и в русских вопросах. Служебные слова весят больше, чем буквы ә, ғ, қ и т. п.
const RU_WORDS = new Set(['кто', 'что', 'как', 'где', 'когда', 'почему', 'зачем', 'какой', 'какая', 'какое', 'какие',
  'такой', 'такая', 'такое', 'расскажи', 'расскажите', 'найди', 'найдите', 'объясни', 'про', 'о', 'об', 'и', 'в', 'на',
  'для', 'это', 'ли', 'мне', 'информацию', 'был', 'была', 'были', 'чем', 'есть', 'из', 'по', 'с', 'со', 'от']);
const KK_WORDS = new Set(['туралы', 'жайлы', 'қандай', 'кім', 'не', 'неге', 'қалай', 'қашан', 'қайда', 'айтып', 'айт',
  'бер', 'беріңіз', 'тап', 'табыңыз', 'және', 'мен', 'деген', 'дегеніміз', 'ақпарат', 'бойынша', 'үшін', 'ма', 'ме',
  'ба', 'бе', 'па', 'пе', 'бар', 'жоқ', 'түсіндір', 'кімдер']);
// Имена посреди фразы (с заглавной буквы) почти не учитываем: «Творчество Мағжана Жұмабаева» — русский вопрос.
const RU_SUFFIX = /(ство|ость|ости|ние|ния|нии|ция|ции|ия|ии|ию|ого|ему|ому|ыми|ими|ая|яя|ый|ий|ой)$/;
function questionLang(text) {
  const words = text.match(/[A-Za-zА-ЯЁа-яёӘәҒғҚқҢңӨөҰұҮүҺһІі]+/g) || [];
  let ru = 0, kk = 0;
  words.forEach((orig, i) => {
    const w = orig.toLowerCase();
    const name = i > 0 && orig[0] !== w[0];
    if (RU_WORDS.has(w)) ru += 2;
    else if (KK_WORDS.has(w)) kk += 2;
    else if (/[әғқңөұүһі]/.test(w)) kk += name ? 0.3 : 1;
    else if (/[а-яё]/.test(w)) ru += name ? 0.1 : RU_SUFFIX.test(w) ? 1 : 0.5;
  });
  return kk > ru ? 'kk' : 'ru';
}
const LANG_NAMES = { ru: 'русский', kk: 'казахский' };

// Модель иногда повторяет в начале ответа служебную строку «Язык ответа: …».
// Придерживаем начало текста до первого перевода строки и отбрасываем такую строку.
const ECHO_LINE = /^\s*(?:Язык ответа|Жауап тілі)\s*:[^\n]*\n+/i;
function dropEchoedHeader(onText) {
  let head = '', passed = false;
  const flush = () => { passed = true; const rest = head.replace(ECHO_LINE, ''); head = ''; if (rest) onText(rest); };
  return {
    push(text) {
      if (passed) return onText(text);
      head += text;
      if (head.trim() && (/\n/.test(head.trimStart()) || head.length > 300)) flush();
    },
    end() { if (!passed) flush(); },
  };
}

// mode: 'catalog' — есть только описания книг из каталога; 'books' — есть текст найденных страниц.
async function streamAnswer(question, sources, emit, queries = [], mode = 'catalog') {
  const filter = dropEchoedHeader(emit);
  const onText = (t) => filter.push(t);
  try {
    await streamRawAnswer(question, sources, onText, queries, mode);
  } finally {
    filter.end();
  }
}

function buildPrompt(question, sources, queries, mode) {
  const code = questionLang(question);
  const lang = LANG_NAMES[code];
  // Когда большинство найденных книг на другом языке, модель тянет перейти на него.
  // Поэтому язык ответа указываем и в системной инструкции, и в самом конце сообщения.
  let langRule = code === 'kk'
    ? 'Жауапты толығымен ҚАЗАҚ тілінде жаз (тақырыптар мен түсініктемелер де). Бірінші бөлімнің тақырыбы «## Қысқаша».'
    : 'Пиши весь ответ ТОЛЬКО на РУССКОМ языке (заголовки и пояснения тоже), даже если источники казахские. Первый раздел называется «## Кратко».';
  if (mode === 'books') {
    const system = `${BOOKS_SYSTEM}\n\nЯзык ответа: ${lang}. ${langRule}`;
    const prompt = `${langRule}\n\nВопрос: ${question}\n\nСтраницы книг библиотеки:\n\n${formatPassages(sources)}\n\n${langRule}`;
    return { system, prompt };
  }
  langRule += code === 'kk'
    ? ' Орысша кітап атауларын жақшада қазақшаға аудар. Әдебиет бөлімінің тақырыбы «## АӨУ кітапханасынан не оқуға болады».'
    : ' Казахские названия книг переводи на русский в скобках. Раздел литературы — «## Что читать в библиотеке АРУ».';
  const searched = queries.map((q) => `«${q.text}»`).join(', ');
  const system = `${ANSWER_SYSTEM}\n\nЯзык ответа: ${lang}. ${langRule}`;
  const prompt = `${langRule}\n\nВопрос: ${question}\n\nВ каталоге искали по словам: ${searched || '—'}\n\nЗаписи каталога neb.arsu.kz:\n${formatSources(sources)}\n\n${langRule}`;
  return { system, prompt };
}

async function streamRawAnswer(question, sources, onText, queries, mode) {
  const { system, prompt } = buildPrompt(question, sources, queries, mode);
  if (useGemini()) {
    // Переключиться на другую модель можно, только пока пользователю ещё ничего не отправлено.
    await withGeminiModels(ANSWER_MODELS, async (model) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FIRST_CHUNK_TIMEOUT);
      try {
        const stream = await getGemini().models.generateContentStream({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            abortSignal: ctrl.signal,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        });
        let any = false;
        for await (const chunk of stream) {
          if (!chunk.text) continue;
          if (!any) { any = true; clearTimeout(timer); }
          onText(chunk.text);
        }
        if (!any) throw new Error('ИИ не дал ответа на этот вопрос. Попробуйте переформулировать.');
      } finally {
        clearTimeout(timer);
      }
    });
    return;
  }
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') throw new Error('ИИ отказался отвечать на этот вопрос. Попробуйте переформулировать.');
  return final;
}

function describeError(e) {
  if (e?.name === 'AbortError') return 'Модели Gemini сейчас перегружены и не отвечают. Попробуйте через пару минут.';
  if (e instanceof GeminiError) {
    if (e.status === 429) return 'Бесплатный лимит Gemini на сейчас исчерпан. Подождите минуту (или до завтра) и повторите.';
    if (e.status === 503 || e.status === 500) return 'Модели Gemini сейчас перегружены. Попробуйте через пару минут.';
    if (e.status === 400 && /api key/i.test(e.message)) return 'Неверный ключ Gemini. Проверьте GEMINI_API_KEY в файле .env.';
    if (e.status === 404) return 'Модели Gemini недоступны для этого ключа. Укажите другую модель в GEMINI_MODEL в файле .env.';
    return `Ошибка Gemini API (${e.status}): ${e.message.slice(0, 300)}`;
  }
  if (e instanceof Anthropic.AuthenticationError) return 'Неверный ключ Claude API. Проверьте ANTHROPIC_API_KEY в файле .env.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'У ключа Claude API нет доступа к модели.';
  if (e instanceof Anthropic.RateLimitError) return 'Слишком много запросов к ИИ. Подождите минуту и повторите.';
  if (e instanceof Anthropic.APIConnectionError) return 'Нет связи с Claude API.';
  // Например, «credit balance is too low» при нулевом балансе — показываем причину как есть.
  if (e instanceof Anthropic.BadRequestError) return `Claude API отклонил запрос: ${e.error?.error?.message || e.message}`;
  if (e instanceof Anthropic.APIError) return `Ошибка Claude API (${e.status}).`;
  return e.message;
}

module.exports = { hasKey, planQueries, streamAnswer, describeError };
