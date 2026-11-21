'use strict';

(function attachProviderCatalog(root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  if (root) root.TGProviderCatalog = catalog;
})(typeof window !== 'undefined' ? window :
  (typeof globalThis !== 'undefined' ? globalThis : this), function buildProviderCatalog() {
  // API roots are separate from resource paths. The adapter selects the exact
  // chat, Responses, Messages, and models route for each provider.
  return [
    { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', protocol: 'responses', authType: 'bearer', chatPath: '/chat/completions', responsesPath: '/responses', modelsPath: '/models' },
    { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'anthropic', name: 'Anthropic Claude', url: 'https://api.anthropic.com/v1', protocol: 'anthropic', authType: 'x-api-key', messagesPath: '/messages', modelsPath: '/models?limit=100' },
    { id: 'gemini', name: 'Google Gemini API', url: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'xai', name: 'xAI Grok', url: 'https://api.x.ai/v1', protocol: 'responses', authType: 'bearer', chatPath: '/chat/completions', responsesPath: '/responses', modelsPath: '/models' },
    { id: 'mistral', name: 'Mistral AI', url: 'https://api.mistral.ai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', responsesPath: '/responses', modelsPath: '/models', responsesModels: ['deepseek-v4-flash'] },
    { id: 'qwen', name: 'Alibaba Qwen / DashScope', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models', notice: 'Регион API-ключа должен совпадать с регионом DashScope endpoint. Для других регионов замените адрес API.' },
    { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'cerebras', name: 'Cerebras', url: 'https://api.cerebras.ai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'together', name: 'Together AI', url: 'https://api.together.ai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'fireworks', name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'deepinfra', name: 'DeepInfra', url: 'https://api.deepinfra.com/v1/openai', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'siliconflow', name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'nvidia', name: 'NVIDIA NIM', url: 'https://integrate.api.nvidia.com/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'perplexity', name: 'Perplexity', url: 'https://api.perplexity.ai', protocol: 'responses', authType: 'bearer', responsesPath: '/v1/responses', chatPath: '/chat/completions', modelsPath: '/v1/models', defaultModel: 'openai/gpt-5.6-sol', notice: 'Используется Agent API (Responses); прежний Sonar Chat Completions больше не является основным интерфейсом.' },
    { id: 'huggingface', name: 'Hugging Face Inference Providers', url: 'https://router.huggingface.co/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'novita', name: 'Novita AI', url: 'https://api.novita.ai/openai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'sambanova', name: 'SambaNova Cloud', url: 'https://api.sambanova.ai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'hyperbolic', name: 'Hyperbolic', url: 'https://api.hyperbolic.ai/inference/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'upstage', name: 'Upstage Solar', url: 'https://api.upstage.ai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', responsesPath: '/responses', modelsPath: '/models', responsesModels: ['solar-pro4', 'solar-pro4-260806', 'solar-mini4', 'solar-mini4-260922'], notice: 'Responses API доступен только для Solar Pro 4 и Solar Mini 4; остальные модели идут через Chat Completions.' },
    { id: 'zai', name: 'Z.ai GLM', url: 'https://api.z.ai/api/paas/v4', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'moonshot', name: 'Moonshot AI / Kimi', url: 'https://api.moonshot.ai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'minimax', name: 'MiniMax', url: 'https://api.minimax.io/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'ai21', name: 'AI21 Labs', url: 'https://api.ai21.com/studio/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsEndpoint: false },
    { id: 'cohere', name: 'Cohere Compatibility API', url: 'https://api.cohere.ai/compatibility/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'vercel', name: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', responsesPath: '/responses', modelsPath: '/models' },
    { id: 'clarifai', name: 'Clarifai', url: 'https://api.clarifai.com/v2/ext/openai/v1', protocol: 'openai', authType: 'key', chatPath: '/chat/completions', responsesPath: '/responses', modelsEndpoint: false },
    { id: 'nebius', name: 'Nebius AI Studio', url: 'https://api.studio.nebius.ai/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models' },
    { id: 'hunyuan', name: 'Tencent Hunyuan', url: 'https://api.hunyuan.cloud.tencent.com/v1', protocol: 'openai', authType: 'bearer', chatPath: '/chat/completions', modelsPath: '/models', notice: 'Используется OpenAI-compatible Chat Completions API; новые возможности Tencent постепенно переводит на TokenHub.' }
  ];
});