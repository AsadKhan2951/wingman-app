'use strict';
/**
 * Offline checks for chat voice notes on ElevenLabs (fake fetch — nothing is
 * called).   node scripts/test-voice-chat.js
 */
process.env.ELEVENLABS_API_KEY = 'test';
delete process.env.OPENAI_API_KEY;

const reqs = [];
let sttText = 'kal teen baje meeting rakh do';
global.fetch = async (url, opts = {}) => {
  reqs.push({ url: String(url), opts });
  if (/speech-to-text/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ text: sttText, language_code: 'urd' }) };
  }
  if (/text-to-speech/.test(url)) {
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('OggS-fake-audio') };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const claude = require('../src/llm/claude');
let romanCalls = 0;
claude.complete = async () => { romanCalls += 1; return 'Kal teen baje meeting rakh do'; };

const voice = require('../src/services/voice');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails += 1; };

(async () => {
  check('voice on with only the ElevenLabs key', voice.enabled());

  const t1 = await voice.transcribe(Buffer.from('x'));
  const sttReq = reqs.find((r) => /speech-to-text/.test(r.url));
  check('voice note → ElevenLabs Scribe, not OpenAI', !!sttReq && !reqs.some((r) => /openai/.test(r.url)));
  check('Roman Urdu transcript passed through as-is', t1 === 'kal teen baje meeting rakh do' && romanCalls === 0);

  sttText = 'کل تین بجے میٹنگ رکھ دو';
  const t2 = await voice.transcribe(Buffer.from('x'));
  check('Urdu script → converted to Roman Urdu', romanCalls === 1 && t2 === 'Kal teen baje meeting rakh do');

  reqs.length = 0;
  const a = await voice.speak('Done ✅ *Meeting* set for 3pm https://x.y', { user: { voice_name: 'nova' } });
  const tts = reqs.find((r) => /text-to-speech/.test(r.url));
  check('reply spoken by ElevenLabs as Ogg voice note', a.mimeType === 'audio/ogg' && !!tts);
  check('old OpenAI voice names → Wingman\'s own voice (no voice id override)', /JBFqnCBsd6RMkjVDRZzb|\/text-to-speech\/[^/?]+/.test(tts.url) && !/XrExE9yKIg1WjnStVfdQ/.test(tts.url));
  const body = JSON.parse(tts.opts.body);
  check('emoji / markdown / links stripped before speaking', !/[✅*]|https/.test(body.text), body.text);

  reqs.length = 0;
  await voice.speak('Hello', { user: {} });
  check('no choice → Wingman\'s voice (ELEVENLABS_VOICE_ID)', reqs[0].url.includes('/text-to-speech/JBFqnCBsd6RMkjVDRZzb'));
  reqs.length = 0;
  await voice.speak('Hello', { user: { voice_name: 'matilda' } });
  check('a voice the user picked is honoured', /XrExE9yKIg1WjnStVfdQ/.test(reqs[0].url));

  check('"british" / "deep" / "female" resolve', voice.resolveVoice('british') === 'george' && voice.resolveVoice('jeremy') === 'wingman' && voice.resolveVoice('deep') === 'brian' && voice.resolveVoice('female') === 'matilda');
  check('voice notes only when they sent one (default)', voice.shouldSpeak({}, true) && !voice.shouldSpeak({}, false) && !voice.shouldSpeak({ voice_replies: 'off' }, true));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
