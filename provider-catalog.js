'use strict';

(function attachProviderCatalog(root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  if (root) root.TGProviderCatalog = catalog;
})(typeof window !== 'undefined' ? window :
  (typeof globalThis !== 'undefined' ? globalThis : this), function buildProviderCatalog() {
  // Endpoints are API roots, not full /chat/completions URLs.
  // All entries use OpenAI Chat Completions except Anthropic, which has a native adapter.
  return [
    { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'anthropic', name: 'Anthropic Claude', url: 'https://api.anthropic.com/v1', protocol: 'anthropic', authType: 'x-api-key' },
    { id: 'gemini', name: 'Google Gemini API', url: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai', authType: 'bearer' },
    { id: 'xai', name: 'xAI Grok', url: 'https://api.x.ai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'mistral', name: 'Mistral AI', url: 'https://api.mistral.ai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'qwen', name: 'Alibaba Qwen / DashScope', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'cerebras', name: 'Cerebras', url: 'https://api.cerebras.ai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'together', name: 'Together AI', url: 'https://api.together.ai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'fireworks', name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'deepinfra', name: 'DeepInfra', url: 'https://api.deepinfra.com/v1/openai', protocol: 'openai', authType: 'bearer' },
    { id: 'siliconflow', name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'nvidia', name: 'NVIDIA NIM', url: 'https://integrate.api.nvidia.com/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'perplexity', name: 'Perplexity', url: 'https://api.perplexity.ai', protocol: 'openai', authType: 'bearer', modelsEndpoint: false, defaultModel: 'sonar' },
    { id: 'huggingface', name: 'Hugging Face Inference Providers', url: 'https://router.huggingface.co/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'novita', name: 'Novita AI', url: 'https://api.novita.ai/openai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'sambanova', name: 'SambaNova Cloud', url: 'https://api.sambanova.ai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'hyperbolic', name: 'Hyperbolic', url: 'https://api.hyperbolic.ai/inference/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'upstage', name: 'Upstage Solar', url: 'https://api.upstage.ai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'zai', name: 'Z.ai GLM', url: 'https://api.z.ai/api/paas/v4', protocol: 'openai', authType: 'bearer' },
    { id: 'moonshot', name: 'Moonshot AI / Kimi', url: 'https://api.moonshot.ai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'minimax', name: 'MiniMax', url: 'https://api.minimax.io/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'ai21', name: 'AI21 Labs', url: 'https://api.ai21.com/studio/v1', protocol: 'openai', authType: 'bearer', modelsEndpoint: false },
    { id: 'cohere', name: 'Cohere Compatibility API', url: 'https://api.cohere.com/compatibility/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'vercel', name: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'clarifai', name: 'Clarifai', url: 'https://api.clarifai.com/v2/ext/openai/v1', protocol: 'openai', authType: 'key', modelsEndpoint: false },
    { id: 'nebius', name: 'Nebius AI Studio', url: 'https://api.studio.nebius.ai/v1', protocol: 'openai', authType: 'bearer' },
    { id: 'hunyuan', name: 'Tencent Hunyuan', url: 'https://api.hunyuan.cloud.tencent.com/v1', protocol: 'openai', authType: 'bearer' }
  ];
});
