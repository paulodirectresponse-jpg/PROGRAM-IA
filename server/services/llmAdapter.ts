import { GoogleGenAI } from '@google/genai';
import { db } from '../db/index.js';

export type AgentMode = 'auto' | 'plan' | 'build' | 'review' | 'publish';

export interface LLMRequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PlanOutput {
  objective: string;
  scope_in: string;
  scope_out: string;
  files_affected: string[];
  integrations: string[];
  risks: string[];
  acceptance_criteria: string[];
}

export interface FileChangeProposal {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content: string;
  diff?: string;
}

export interface BuildOutput {
  summary: string;
  explanation: string;
  files: FileChangeProposal[];
}

export interface ChangeProposal {
  id: string;
  summary: string;
  diffSummary?: string;
  requiresConfirmation: boolean;
  files: FileChangeProposal[];
  status: 'pending' | 'applied' | 'rejected';
}

export interface LLMExecutionResult {
  replyText: string;
  mode: AgentMode;
  isDemonstrativeFallback: boolean;
  providerUsed: string;
  modelUsed: string;
  decisionType?: 'explanation' | 'plan' | 'change' | 'review' | 'publish';
  plan?: PlanOutput;
  build?: BuildOutput;
  proposal?: ChangeProposal;
  hasErrors?: boolean;
  errorMessage?: string;
}

export interface ProviderConnectionTestResult {
  success: boolean;
  status: 'success' | 'invalid_key' | 'invalid_model' | 'invalid_url' | 'network_error' | 'incompatible_response';
  message: string;
  statusCode?: number;
  details?: any;
}

export class LLMAdapterService {
  /**
   * Automatic classification of user intent when mode is 'auto'
   */
  static classifyIntent(prompt: string): 'explanation' | 'plan' | 'build' | 'review' | 'publish' {
    const lower = prompt.toLowerCase();
    if (
      lower.includes('explique') ||
      lower.includes('como funciona') ||
      lower.includes('o que é') ||
      lower.includes('por que') ||
      lower.includes('me explique') ||
      lower.includes('o que significa')
    ) {
      return 'explanation';
    }
    if (
      lower.includes('planeje') ||
      lower.includes('plano') ||
      lower.includes('arquitetura') ||
      lower.includes('especificação') ||
      lower.includes('roadmap')
    ) {
      return 'plan';
    }
    if (
      lower.includes('revise') ||
      lower.includes('revisar') ||
      lower.includes('auditoria') ||
      lower.includes('bugs') ||
      lower.includes('analise') ||
      lower.includes('encontre erros')
    ) {
      return 'review';
    }
    if (
      lower.includes('deploy') ||
      lower.includes('publicar') ||
      lower.includes('commit') ||
      lower.includes('push') ||
      lower.includes('pull request') ||
      lower.includes('sincronizar')
    ) {
      return 'publish';
    }
    return 'build';
  }

  /**
   * Centralized Single Source of Truth for Provider Configuration
   */
  static getProviderConfig(targetKey?: string) {
    // 1. Check sqlite providers table
    const providerKey = targetKey || 'useoneai';
    const row = db.prepare('SELECT * FROM providers WHERE provider_key = ?').get(providerKey) as any;

    const openaiKey = process.env.OPENAI_API_KEY || process.env.USEONEAI_API_KEY || '';
    const geminiKey = process.env.GEMINI_API_KEY || '';

    if (providerKey === 'gemini' || (targetKey === undefined && !openaiKey && geminiKey)) {
      return {
        key: 'gemini',
        type: 'gemini' as const,
        apiKey: geminiKey,
        baseUrl: row?.base_url || 'https://generativelanguage.googleapis.com',
        modelId: row?.model_id && !row.model_id.includes('gemini-2.5-flash') ? row.model_id : 'gemini-3.5-flash-lite',
        name: 'Google Gemini',
        isConfigured: Boolean(geminiKey && geminiKey.trim().length > 0),
      };
    }

    // Default to UseOneAI / OpenAI-compatible
    return {
      key: providerKey,
      type: 'openai_compatible' as const,
      apiKey: openaiKey,
      baseUrl: row?.base_url || process.env.OPENAI_BASE_URL || 'https://api.useoneai.app/v1',
      modelId: row?.model_id || process.env.OPENAI_MODEL_ID || 'chatgpt-5.5',
      name: row?.name || 'UseOneAI (OpenAI-Compatible)',
      isConfigured: Boolean(openaiKey && openaiKey.trim().length > 0),
    };
  }

  /**
   * Determine available active configured provider
   */
  static getActiveProviderConfig() {
    // Check UseOneAI / OpenAI first
    const useoneConfig = this.getProviderConfig('useoneai');
    if (useoneConfig.isConfigured) {
      return useoneConfig;
    }

    // Check Gemini
    const geminiConfig = this.getProviderConfig('gemini');
    if (geminiConfig.isConfigured) {
      return geminiConfig;
    }

    return null;
  }

  /**
   * Real provider connection test with precise diagnostic reporting:
   * - conexão aprovada (success)
   * - chave inválida (invalid_key)
   * - modelo inválido (invalid_model)
   * - URL inválida (invalid_url)
   * - erro de rede (network_error)
   * - resposta incompatível (incompatible_response)
   */
  static async testConnection(options: {
    providerKey?: string;
    baseUrl?: string;
    modelId?: string;
  }): Promise<ProviderConnectionTestResult> {
    const config = this.getProviderConfig(options.providerKey);
    const baseUrl = (options.baseUrl || config.baseUrl || '').trim();
    const modelId = (options.modelId || config.modelId || '').trim();
    const apiKey = config.apiKey ? config.apiKey.trim() : '';

    // 1. Validate URL syntax
    if (config.type === 'openai_compatible') {
      try {
        const parsedUrl = new URL(baseUrl);
        if (!parsedUrl.protocol.startsWith('http')) {
          return {
            success: false,
            status: 'invalid_url',
            message: 'URL inválida: o protocolo deve ser http:// ou https://',
          };
        }
      } catch {
        return {
          success: false,
          status: 'invalid_url',
          message: 'URL inválida: o endereço do endpoint está malformado.',
        };
      }
    }

    // 2. Validate API Key existence on server
    if (!apiKey || apiKey.length === 0) {
      return {
        success: false,
        status: 'invalid_key',
        message: 'Chave de API não configurada no servidor. Configure a variável de ambiente correspondente.',
      };
    }

    // 3. Test Gemini Provider
    if (config.type === 'gemini') {
      try {
        const ai = new GoogleGenAI({ apiKey });
        const res = await ai.models.generateContent({
          model: modelId,
          contents: 'Ping test. Reply with: OK',
        });
        if (res && (res.text || (res as any).candidates)) {
          return {
            success: true,
            status: 'success',
            message: `Conexão aprovada! O modelo Gemini "${modelId}" respondeu com sucesso.`,
          };
        }
        return {
          success: false,
          status: 'incompatible_response',
          message: 'Resposta incompatível retornada pela API do Gemini.',
        };
      } catch (err: any) {
        const errStr = (err.message || '').toLowerCase();
        if (errStr.includes('api_key') || errStr.includes('unauthorized') || errStr.includes('401') || errStr.includes('403')) {
          return {
            success: false,
            status: 'invalid_key',
            message: 'Chave inválida: a chave do Gemini foi rejeitada pela API.',
          };
        }
        if (errStr.includes('not found') || errStr.includes('404') || errStr.includes('model')) {
          return {
            success: false,
            status: 'invalid_model',
            message: `Modelo inválido: o modelo "${modelId}" não foi encontrado ou não está disponível.`,
          };
        }
        return {
          success: false,
          status: 'network_error',
          message: `Erro de rede ao conectar à API do Gemini: ${err.message}`,
        };
      }
    }

    // 4. Test OpenAI-Compatible / UseOneAI Provider
    try {
      const cleanBase = baseUrl.replace(/\/+$/, '');
      const endpoint = `${cleanBase}/chat/completions`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Ping' }],
          max_tokens: 5,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const statusCode = response.status;
      const responseText = await response.text();

      // Check HTTP Status codes
      if (statusCode === 401 || statusCode === 403) {
        return {
          success: false,
          status: 'invalid_key',
          statusCode,
          message: `Chave inválida: autenticação falhou com HTTP ${statusCode}. Verifique sua chave de acesso.`,
        };
      }

      if (statusCode === 404) {
        return {
          success: false,
          status: 'invalid_model',
          statusCode,
          message: `Modelo inválido: o modelo "${modelId}" não foi encontrado no endpoint (HTTP 404).`,
        };
      }

      // Parse JSON
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
        return {
          success: false,
          status: 'incompatible_response',
          statusCode,
          message: `Resposta incompatível: o endpoint retornou dados não-JSON (HTTP ${statusCode}).`,
        };
      }

      if (!response.ok) {
        const errorMsg = data?.error?.message || data?.message || responseText.slice(0, 150);
        const lowerErr = errorMsg.toLowerCase();

        if (lowerErr.includes('api key') || lowerErr.includes('unauthorized') || lowerErr.includes('invalid_api_key')) {
          return {
            success: false,
            status: 'invalid_key',
            statusCode,
            message: `Chave inválida: ${errorMsg}`,
          };
        }

        if (lowerErr.includes('model') || lowerErr.includes('does not exist') || lowerErr.includes('not found')) {
          return {
            success: false,
            status: 'invalid_model',
            statusCode,
            message: `Modelo inválido: ${errorMsg}`,
          };
        }

        return {
          success: false,
          status: 'incompatible_response',
          statusCode,
          message: `Erro da API (${statusCode}): ${errorMsg}`,
        };
      }

      // Check if standard choices structure exists
      if (Array.isArray(data.choices) && data.choices.length > 0) {
        return {
          success: true,
          status: 'success',
          statusCode,
          message: `Conexão aprovada! O modelo "${modelId}" respondeu perfeitamente via UseOneAI.`,
        };
      }

      return {
        success: false,
        status: 'incompatible_response',
        statusCode,
        message: 'Resposta incompatível: o retorno não contém o array de "choices" padrão da API.',
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return {
          success: false,
          status: 'network_error',
          message: 'Erro de rede: tempo limite de conexão esgotado (timeout de 12s).',
        };
      }
      return {
        success: false,
        status: 'network_error',
        message: `Erro de rede: não foi possível conectar ao endpoint (${err.message || 'Falha de conexão'}).`,
      };
    }
  }

  /**
   * Robust parser extracting text from various LLM content types:
   * string, array of parts, text objects
   */
  static extractContentText(rawContent: any): string {
    if (typeof rawContent === 'string') {
      return rawContent;
    }
    if (Array.isArray(rawContent)) {
      return rawContent
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            return part.text || part.content || '';
          }
          return '';
        })
        .join('');
    }
    if (rawContent && typeof rawContent === 'object') {
      return rawContent.text || rawContent.content || '';
    }
    return '';
  }

  /**
   * Resilient JSON extractor:
   * Accepts pure JSON, markdown ```json, or embedded { ... }
   * Safely returns null if not JSON without throwing errors
   */
  static extractStructuredJson(text: string): any | null {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();

    // 1. Direct JSON check
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(this.sanitizeJsonString(trimmed));
      } catch {
        // Not direct JSON, continue
      }
    }

    // 2. Markdown ```json ... ``` or ``` ... ```
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const candidate = match[1].trim();
      if ((candidate.startsWith('{') && candidate.endsWith('}')) || (candidate.startsWith('[') && candidate.endsWith(']'))) {
        try {
          return JSON.parse(this.sanitizeJsonString(candidate));
        } catch {
          // Continue scanning
        }
      }
    }

    // 3. Scan for outermost balanced { ... }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = text.substring(firstBrace, lastBrace + 1).trim();
      try {
        return JSON.parse(this.sanitizeJsonString(candidate));
      } catch {
        // Not valid JSON
      }
    }

    return null;
  }

  static sanitizeJsonString(str: string): string {
    return str
      .trim()
      .replace(/,\s*([\]}])/g, '$1')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
  }

  /**
   * Extract files from regular Markdown code blocks when the LLM
   * outputs standard markdown instead of JSON structures.
   */
  static extractFilesFromMarkdown(text: string): FileChangeProposal[] {
    const results: FileChangeProposal[] = [];
    // Match code blocks with possible filename or lang
    const codeBlockRegex = /```([a-zA-Z0-9_\-./]+)?(?::|\s+filename=|\s+path=|\s+title=)?\s*([^\n\r]*)\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const langOrFirst = (match[1] || '').trim();
      let rawHeader = (match[2] || '').trim().replace(/["'`]/g, '');
      const code = match[3];

      let detectedPath = '';
      if (rawHeader && /^[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+$/.test(rawHeader)) {
        detectedPath = rawHeader;
      } else if (langOrFirst && /^[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+$/.test(langOrFirst)) {
        detectedPath = langOrFirst;
      } else {
        // Look inside first 4 lines of code for comment indicator
        const firstLines = code.split('\n').slice(0, 4).join('\n');
        const commentMatch =
          firstLines.match(/<!--\s*(?:filename:\s*)?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\s*-->/i) ||
          firstLines.match(/\/\/\s*(?:filename:\s*)?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/i) ||
          firstLines.match(/\/\*\s*(?:filename:\s*)?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\s*\*\//i);
        if (commentMatch) {
          detectedPath = commentMatch[1];
        }
      }

      if (detectedPath && code.trim().length > 0) {
        if (!results.some((r) => r.path === detectedPath)) {
          results.push({
            path: detectedPath,
            action: 'modify',
            content: code,
          });
        }
      }
    }

    // If no path was identified, but an HTML document code block exists:
    if (results.length === 0) {
      const htmlBlockMatch = text.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
      if (htmlBlockMatch && (htmlBlockMatch[1].includes('<html') || htmlBlockMatch[1].includes('<!DOCTYPE'))) {
        results.push({
          path: 'index.html',
          action: 'modify',
          content: htmlBlockMatch[1],
        });
      }
    }

    return results;
  }

  /**
   * Generate lightweight unified diff for UI display
   */
  static computeDiff(oldContent: string | null, newContent: string): string {
    if (!oldContent) {
      const lines = newContent.split('\n');
      return `+ Novo arquivo (${lines.length} linhas criadas)`;
    }

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const diffLines: string[] = [];

    let changes = 0;
    const maxPreview = 12;

    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      const o = oldLines[i];
      const n = newLines[i];
      if (o !== n) {
        changes++;
        if (diffLines.length < maxPreview) {
          if (o !== undefined && n === undefined) diffLines.push(`- L${i + 1}: ${o.slice(0, 70)}`);
          else if (o === undefined && n !== undefined) diffLines.push(`+ L${i + 1}: ${n.slice(0, 70)}`);
          else {
            diffLines.push(`- L${i + 1}: ${o?.slice(0, 70)}`);
            diffLines.push(`+ L${i + 1}: ${n?.slice(0, 70)}`);
          }
        }
      }
    }

    if (changes === 0) return 'Sem alterações de conteúdo';
    const summary = `${changes} linhas modificadas`;
    return diffLines.length > 0 ? `${summary}\n${diffLines.join('\n')}` : summary;
  }

  /**
   * Main Prompt Execution with Support for "auto" mode
   */
  static async executePrompt(options: {
    prompt: string;
    mode: AgentMode;
    projectId: string;
    existingFiles: Record<string, string>;
    appliedSkills: string[];
    conversationHistory: Array<{ sender: string; content: string }>;
    providerKey?: string;
    modelId?: string;
  }): Promise<LLMExecutionResult> {
    const { prompt, mode, appliedSkills, existingFiles, conversationHistory, providerKey, modelId } = options;
    let providerConfig = providerKey ? this.getProviderConfig(providerKey) : null;
    if (!providerConfig || !providerConfig.isConfigured) {
      providerConfig = this.getActiveProviderConfig();
    }
    if (providerConfig && modelId) {
      providerConfig = { ...providerConfig, modelId };
    }

    const skillsText = appliedSkills.length > 0 ? `\nSkills Ativas: ${appliedSkills.join(', ')}.` : '';
    const filesList = Object.keys(existingFiles).join(', ') || 'Nenhum arquivo ainda criado.';

    // If an active real provider is configured, call it
    if (providerConfig) {
      try {
        if (providerConfig.type === 'openai_compatible') {
          return await this.callOpenAICompatible(providerConfig, {
            prompt,
            mode,
            skillsText,
            filesList,
            existingFiles,
            conversationHistory,
          });
        } else if (providerConfig.type === 'gemini') {
          return await this.callGemini(providerConfig, {
            prompt,
            mode,
            skillsText,
            filesList,
            existingFiles,
            conversationHistory,
          });
        }
      } catch (err: any) {
        console.error('Erro na chamada do provedor de IA:', err);
        const fallback = this.generateDemonstrativeFallback(prompt, mode, existingFiles, appliedSkills);
        fallback.replyText = `⚠️ **Falha na comunicação com ${providerConfig.name} (${providerConfig.modelId})**: ${err.message || 'Erro de conexão'}.\n\n` + fallback.replyText;
        return fallback;
      }
    }

    // Explicit demonstrative fallback when no keys are configured
    return this.generateDemonstrativeFallback(prompt, mode, existingFiles, appliedSkills);
  }

  private static buildSystemPrompt(mode: AgentMode, skillsText: string, filesList: string, existingFiles: Record<string, string>) {
    return `Você é o Forge Agent, uma inteligência de desenvolvimento de software full-stack que opera em projetos web reais.
Modo Selecionado: ${mode.toUpperCase()}.
${skillsText}
Arquivos existentes no workspace: [${filesList}].

DIRETRIZES DE OPERAÇÃO:
${
  mode === 'auto'
    ? `Você está no Modo AUTOMÁTICO. Avalie a intenção do usuário:
1. Explicação / Dúvida / Pergunta técnica: responda diretamente com texto explicativo e claro. NÃO crie arquivos e NÃO gere planos forçados.
2. Planejamento / Nova feature de grande porte: se o usuário pedir para planejar, forneça um bloco JSON:
\`\`\`json
{
  "type": "plan",
  "plan": {
    "objective": "...",
    "scope_in": "...",
    "scope_out": "...",
    "files_affected": ["index.html"],
    "integrations": [],
    "risks": [],
    "acceptance_criteria": ["..."]
  },
  "explanation": "..."
}
\`\`\`
3. Alteração ou criação de código: gere a proposta de alteração com arquivos estruturados:
\`\`\`json
{
  "type": "change",
  "summary": "Resumo objetivo da alteração",
  "requires_confirmation": false,
  "files": [
    {
      "path": "index.html",
      "action": "create" | "modify" | "delete",
      "content": "conteúdo completo atualizado do arquivo"
    }
  ],
  "explanation": "Explicação da implementação para o usuário"
}
\`\`\`
4. Revisão de código / Quality Gates: audite o código, verifique acessibilidade, segurança e integridade.
5. Publicação: mostre checklist de release. Ações destrutivas NUNCA ocorrem sem confirmação.`
    : mode === 'plan'
    ? `No modo PLANEJAR, gere um plano técnico em JSON:
\`\`\`json
{
  "objective": "...",
  "scope_in": "...",
  "scope_out": "...",
  "files_affected": ["index.html"],
  "integrations": [],
  "risks": [],
  "acceptance_criteria": ["..."]
}
\`\`\` seguido de uma explicação elegante.`
    : mode === 'build'
    ? `No modo CONSTRUIR, retorne estritamente um bloco JSON estruturado com as alterações de arquivo a serem aplicadas no workspace:
\`\`\`json
{
  "summary": "Resumo das alterações",
  "explanation": "Explicação técnica",
  "files": [
    {
      "path": "index.html",
      "action": "create" | "modify" | "delete",
      "content": "código completo atualizado do arquivo"
    }
  ]
}
\`\`\`
IMPORTANTE: Se você não retornar o bloco JSON com a lista de arquivos estruturada, o sistema rejeitará a alteração por segurança.`
    : mode === 'review'
    ? `No modo REVISAR, forneça relatório de auditoria técnica dos arquivos, conformidade com os critérios de aceite e segurança.`
    : `No modo PUBLICAR, elabore o checklist de release e preparação para commit/push no GitHub.`
}
Responda sempre em português claro, elegante e profissional.`;
  }

  private static async callOpenAICompatible(
    config: { apiKey: string; baseUrl: string; modelId: string; name: string },
    context: any
  ): Promise<LLMExecutionResult> {
    const systemPrompt = this.buildSystemPrompt(context.mode, context.skillsText, context.filesList, context.existingFiles);

    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          ...context.conversationHistory.slice(-6).map((h: any) => ({
            role: h.sender === 'user' ? 'user' : 'assistant',
            content: h.content,
          })),
          { role: 'user', content: context.prompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API retornou HTTP ${response.status}: ${errText.substring(0, 300)}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    const textContent = this.extractContentText(rawContent);

    return this.parseLLMResponse(textContent, context.mode, config.name, config.modelId, context.existingFiles);
  }

  private static async callGemini(
    config: { apiKey: string; modelId: string; name: string },
    context: any
  ): Promise<LLMExecutionResult> {
    const ai = new GoogleGenAI({ apiKey: config.apiKey });
    const systemPrompt = this.buildSystemPrompt(context.mode, context.skillsText, context.filesList, context.existingFiles);

    const fullPrompt = `${systemPrompt}\n\nHistórico Recente:\n${context.conversationHistory
      .slice(-4)
      .map((h: any) => `${h.sender}: ${h.content}`)
      .join('\n')}\n\nUsuário: ${context.prompt}`;

    const candidateModels = [
      config.modelId || 'gemini-3.5-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-3.6-flash',
    ];

    let lastError: any = null;
    let successfulModel = config.modelId || 'gemini-3.5-flash-lite';
    let textContent = '';

    for (const m of candidateModels) {
      try {
        const res = await ai.models.generateContent({
          model: m,
          contents: fullPrompt,
        });
        textContent = res.text || '';
        successfulModel = m;
        break;
      } catch (err: any) {
        lastError = err;
        console.warn(`Tentativa com modelo Gemini ${m} falhou:`, err.message || err);
      }
    }

    if (!textContent && lastError) {
      throw lastError;
    }

    return this.parseLLMResponse(textContent, context.mode, config.name, successfulModel, context.existingFiles);
  }

  /**
   * Resilient parsing of LLM response
   */
  static parseLLMResponse(
    content: string,
    mode: AgentMode,
    providerName: string,
    modelId: string,
    existingFiles: Record<string, string> = {}
  ): LLMExecutionResult {
    const structured = this.extractStructuredJson(content);

    let plan: PlanOutput | undefined;
    let build: BuildOutput | undefined;
    let proposal: ChangeProposal | undefined;
    let decisionType: 'explanation' | 'plan' | 'change' | 'review' | 'publish' = 'explanation';
    let hasErrors = false;
    let errorMessage: string | undefined;

    // 1. AUTO MODE HANDLING
    if (mode === 'auto') {
      if (structured) {
        // Plan detected
        if (structured.plan || structured.type === 'plan' || structured.objective) {
          decisionType = 'plan';
          plan = structured.plan || structured;
        }
        // File change detected in JSON
        else if (structured.files && Array.isArray(structured.files) && structured.files.length > 0) {
          decisionType = 'change';
          const validFiles: FileChangeProposal[] = structured.files.filter(
            (f: any) => f && typeof f.path === 'string' && typeof f.content === 'string'
          );

          if (validFiles.length > 0) {
            for (const f of validFiles) {
              const old = existingFiles[f.path] || null;
              f.diff = this.computeDiff(old, f.content);
            }

            const requiresConf = Boolean(
              structured.requires_confirmation ?? (validFiles.length > 1 || validFiles.some((f) => f.action === 'delete'))
            );

            proposal = {
              id: 'prop-' + Date.now(),
              summary: structured.summary || 'Proposta de alteração de arquivos',
              diffSummary: validFiles.map((f) => `${f.action.toUpperCase()} ${f.path}`).join(', '),
              requiresConfirmation: requiresConf,
              files: validFiles,
              status: 'pending',
            };

            build = {
              summary: structured.summary || 'Alterações geradas no modo Automático',
              explanation: structured.explanation || content,
              files: validFiles,
            };
          }
        }
      }

      // If no structured files, check if the LLM outputted files in markdown code blocks
      if (!build && !plan) {
        const mdFiles = this.extractFilesFromMarkdown(content);
        if (mdFiles.length > 0) {
          decisionType = 'change';
          for (const f of mdFiles) {
            const old = existingFiles[f.path] || null;
            f.diff = this.computeDiff(old, f.content);
          }

          proposal = {
            id: 'prop-' + Date.now(),
            summary: 'Alterações identificadas no código gerado',
            diffSummary: mdFiles.map((f) => `${f.action.toUpperCase()} ${f.path}`).join(', '),
            requiresConfirmation: mdFiles.length > 1,
            files: mdFiles,
            status: 'pending',
          };

          build = {
            summary: 'Arquivos gerados a partir do código',
            explanation: content,
            files: mdFiles,
          };
        } else {
          // Plain text response in auto mode is treated as clean explanation
          decisionType = 'explanation';
        }
      }

      // Clean conversational reply text for UI
      let cleanReply = content;
      if (structured && (structured.explanation || structured.summary)) {
        cleanReply = structured.explanation || structured.summary;
      }

      return {
        replyText: cleanReply || content,
        mode: 'auto',
        decisionType,
        isDemonstrativeFallback: false,
        providerUsed: providerName,
        modelUsed: modelId,
        plan,
        build,
        proposal,
      };
    }

    // 2. BUILD MODE HANDLING (Structured or Markdown fallback)
    if (mode === 'build') {
      let validFiles: FileChangeProposal[] = [];
      if (structured && Array.isArray(structured.files) && structured.files.length > 0) {
        validFiles = structured.files.filter(
          (f: any) => f && typeof f.path === 'string' && typeof f.content === 'string'
        );
      } else {
        // Try fallback to markdown code blocks
        validFiles = this.extractFilesFromMarkdown(content);
      }

      if (validFiles.length > 0) {
        for (const f of validFiles) {
          const old = existingFiles[f.path] || null;
          f.diff = this.computeDiff(old, f.content);
        }

        build = {
          summary: structured?.summary || 'Código gerado com sucesso',
          explanation: structured?.explanation || content,
          files: validFiles,
        };
        decisionType = 'change';
      } else {
        // Conversational explanation without files
        decisionType = 'explanation';
      }

      return {
        replyText: content,
        mode: 'build',
        decisionType,
        isDemonstrativeFallback: false,
        providerUsed: providerName,
        modelUsed: modelId,
        build,
        hasErrors: false,
      };
    }

    // 3. PLAN MODE HANDLING
    if (mode === 'plan') {
      if (structured && (structured.objective || structured.plan)) {
        plan = structured.plan || structured;
        decisionType = 'plan';
      }
      return {
        replyText: content,
        mode: 'plan',
        decisionType: 'plan',
        isDemonstrativeFallback: false,
        providerUsed: providerName,
        modelUsed: modelId,
        plan,
      };
    }

    // 4. REVIEW / PUBLISH
    return {
      replyText: content,
      mode,
      decisionType: mode === 'review' ? 'review' : 'publish',
      isDemonstrativeFallback: false,
      providerUsed: providerName,
      modelUsed: modelId,
    };
  }

  /**
   * Deterministic demonstrative fallback when no API key is available or during offline execution
   */
  static generateDemonstrativeFallback(
    prompt: string,
    mode: AgentMode,
    existingFiles: Record<string, string>,
    appliedSkills: string[]
  ): LLMExecutionResult {
    const notice = `> ℹ️ **[MODO DEMONSTRATIVO: Provedor de IA não configurado ou sem chave ativa]**\n> Nenhuma chave foi encontrada em \`OPENAI_API_KEY\` ou \`GEMINI_API_KEY\`. Para habilitar chamadas reais de IA pelo UseOneAI ou Gemini, acesse a aba **Provedores** na barra lateral e configure suas credenciais seguras no servidor.\n\n`;

    // Auto Mode Fallback Decision
    if (mode === 'auto') {
      const lower = prompt.toLowerCase();
      const isExplanation = lower.includes('o que') || lower.includes('como funciona') || lower.includes('explique') || lower.includes('olá') || lower.includes('ajuda');
      const isPlanning = lower.includes('planeje') || lower.includes('arquitetura') || lower.includes('escopo');

      if (isExplanation) {
        return {
          replyText: `${notice}Olá! Estou no modo **Automático**. Eu analiso sua solicitação e executo a ação mais apropriada: explico conceitos, planejo arquiteturas ou implemento alterações diretamente no código do workspace.\n\nPara começar, você pode me pedir para criar uma tela, adicionar componentes ou explicar a estrutura do projeto.`,
          mode: 'auto',
          decisionType: 'explanation',
          isDemonstrativeFallback: true,
          providerUsed: 'Forge Local Fallback Engine',
          modelUsed: 'deterministic-auto-v1',
        };
      }

      if (isPlanning) {
        return this.generateDemonstrativeFallback(prompt, 'plan', existingFiles, appliedSkills);
      }

      // Default to code change in auto mode
      return this.generateDemonstrativeFallback(prompt, 'build', existingFiles, appliedSkills);
    }

    if (mode === 'plan') {
      const plan: PlanOutput = {
        objective: `Implementar solicitação: "${prompt.slice(0, 80)}"`,
        scope_in: 'Criação de componentes reativos, estilos integrados e layout adaptativo no sandbox.',
        scope_out: 'Deploy externo em nuvem ou bancos remotos de terceiros nesta iteração.',
        files_affected: ['index.html'],
        integrations: ['Forge Preview Sandbox', 'Audit Logs'],
        risks: ['Necessidade de validação visual de compatibilidade de tela.'],
        acceptance_criteria: [
          'Interface funcional carregando sem erros no Live Preview.',
          'Interatividade imediata nos botões de ação.',
          'Nenhum segredo ou token exposto no código fonte.',
        ],
      };

      const replyText = `${notice}### 📋 Plano Técnico Proposto pelo Forge Agent

- **Objetivo**: ${plan.objective}
- **Escopo Incluído**: ${plan.scope_in}
- **Escopo Excluído**: ${plan.scope_out}
- **Arquivos Afetados**: \`${plan.files_affected.join('`, `')}\`
- **Critérios de Aceite**:
${plan.acceptance_criteria.map((c) => `  - [ ] ${c}`).join('\n')}

Revise os detalhes acima. Clique no botão **"Aprovar Plano"** ou alterne para o modo **Construir** para gerar o código e atualizar o preview ao vivo.`;

      return {
        replyText,
        mode: 'plan',
        decisionType: 'plan',
        isDemonstrativeFallback: true,
        providerUsed: 'Forge Local Fallback Engine',
        modelUsed: 'deterministic-plan-v1',
        plan,
      };
    }

    if (mode === 'build') {
      const titleClean = prompt.replace(/[^\w\sÀ-ú]/gi, '').slice(0, 40) || 'Aplicação Forge';
      const newHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${titleClean} — Forge Agent</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #0b0f19; color: #f8fafc; }
  </style>
</head>
<body class="p-6 md:p-8 min-h-screen flex flex-col justify-between">
  <div class="max-w-4xl w-full mx-auto space-y-6">
    <!-- Header -->
    <header class="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800/80 pb-5 gap-4">
      <div>
        <div class="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-cyan-950/80 border border-cyan-800/50 text-cyan-300 text-xs font-medium tracking-wide mb-2">
          <span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
          Versão Vertical Construída
        </div>
        <h1 class="text-2xl font-bold text-slate-100">${titleClean}</h1>
        <p class="text-xs text-slate-400 mt-1">Solicitação: "${prompt.slice(0, 100)}"</p>
      </div>
      <div class="flex items-center gap-2">
        <span class="px-2.5 py-1 text-xs rounded bg-slate-800 text-slate-300 border border-slate-700">Status: Ativo</span>
      </div>
    </header>

    <!-- Cards Grid -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="p-4 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 transition">
        <span class="text-xs text-slate-400">Total de Entradas</span>
        <div class="text-3xl font-bold text-slate-100 mt-1" id="counter-val">12</div>
        <div class="text-xs text-emerald-400 mt-2">↑ 24% nas últimas 24h</div>
      </div>
      <div class="p-4 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 transition">
        <span class="text-xs text-slate-400">Eficiência de Execução</span>
        <div class="text-3xl font-bold text-cyan-400 mt-1">99.8%</div>
        <div class="text-xs text-slate-400 mt-2">Sandbox otimizado</div>
      </div>
      <div class="p-4 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 transition">
        <span class="text-xs text-slate-400">Verificações de Segurança</span>
        <div class="text-3xl font-bold text-emerald-400 mt-1">100%</div>
        <div class="text-xs text-slate-400 mt-2">Nenhum segredo exposto</div>
      </div>
    </div>

    <!-- Interactive List Panel -->
    <div class="p-5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-slate-200">Gerenciador de Itens Dinâmicos</h2>
        <div class="flex gap-2">
          <input id="item-input" type="text" placeholder="Adicionar novo registro..." class="px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500 w-52" />
          <button id="btn-add" class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 transition cursor-pointer">
            + Adicionar
          </button>
        </div>
      </div>

      <ul id="items-list" class="divide-y divide-slate-800/80 text-xs">
        <li class="py-2.5 flex items-center justify-between text-slate-300">
          <span class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
            Configuração de arquitetura inicial
          </span>
          <span class="text-slate-500 font-mono">Concluído</span>
        </li>
        <li class="py-2.5 flex items-center justify-between text-slate-300">
          <span class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-cyan-400"></span>
            Implementação da interface reativa no sandbox
          </span>
          <span class="text-slate-500 font-mono">Em Execução</span>
        </li>
      </ul>
    </div>
  </div>

  <footer class="text-center text-xs text-slate-500 border-t border-slate-900 pt-4 mt-8">
    Gerado pelo Forge Agent • Live Sandbox Preview
  </footer>

  <script>
    let count = 12;
    const counterEl = document.getElementById('counter-val');
    const inputEl = document.getElementById('item-input');
    const listEl = document.getElementById('items-list');

    document.getElementById('btn-add').addEventListener('click', () => {
      const val = inputEl.value.trim();
      if (!val) return;
      count++;
      counterEl.textContent = count;
      const li = document.createElement('li');
      li.className = 'py-2.5 flex items-center justify-between text-slate-300 animate-fade-in';
      li.innerHTML = \`
        <span class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
          \${val}
        </span>
        <span class="text-slate-500 font-mono">Adicionado agora</span>
      \`;
      listEl.prepend(li);
      inputEl.value = '';
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('btn-add').click();
      }
    });
  </script>
</body>
</html>`;

      const oldIndex = existingFiles['index.html'] || null;
      const diffStr = this.computeDiff(oldIndex, newHtml);

      const build: BuildOutput = {
        summary: `Atualizei a estrutura de arquivos no sandbox para atender: "${prompt.slice(0, 60)}"`,
        explanation: 'Arquivo index.html regenerado com componentes interativos, Tailwind CSS estilizado em modo escuro e scripts de manipulação de estado local.',
        files: [
          {
            path: 'index.html',
            action: 'modify',
            content: newHtml,
            diff: diffStr,
          },
        ],
      };

      const replyText = `${notice}### 🚀 Código Gerado e Aplicado com Sucesso!

- **Ação**: Atualização de \`index.html\` no sandbox do projeto.
- **Resumo**: Interface interativa adaptada ao seu pedido com controles dinâmicos de lista e métricas.
- **Status do Preview**: O live preview ao lado foi recarregado automaticamente.
- **Novo Checkpoint**: Snapshot salvo com histórico de rollback disponível.`;

      return {
        replyText,
        mode: 'build',
        decisionType: 'change',
        isDemonstrativeFallback: true,
        providerUsed: 'Forge Local Fallback Engine',
        modelUsed: 'deterministic-build-v1',
        build,
      };
    }

    if (mode === 'review') {
      const replyText = `${notice}### 🔍 Relatório de Revisão e Quality Gates

- **Build & Execução**: ✅ Aprovado (HTML e recursos carregando no sandbox).
- **Detecção de Segredos**: ✅ Aprovado (Nenhuma credencial ou token privado exposto).
- **Acessibilidade**: ✅ Aprovado (Contraste superior a 4.5:1 nas superfícies escuras).
- **Critérios de Aceite**: Aprovados para o escopo desta versão vertical.

Tudo pronto para publicação ou para uma nova solicitação.`;

      return {
        replyText,
        mode: 'review',
        decisionType: 'review',
        isDemonstrativeFallback: true,
        providerUsed: 'Forge Local Fallback Engine',
        modelUsed: 'deterministic-review-v1',
      };
    }

    // Publish mode
    const replyText = `${notice}### 📦 Resumo para Publicação

- **Projeto**: Projeto pronto e verificado no workspace local.
- **Destinos Disponíveis**:
  - Exportação completa em arquivo ZIP (Disponível imediatamente).
  - Sincronização e Commit com GitHub (Requer configuração do \`GITHUB_TOKEN\` na aba **Integrações**).

Nenhuma ação destrutiva ou commit remoto foi realizado sem sua expressa autorização.`;

    return {
      replyText,
      mode: 'publish',
      decisionType: 'publish',
      isDemonstrativeFallback: true,
      providerUsed: 'Forge Local Fallback Engine',
      modelUsed: 'deterministic-publish-v1',
    };
  }
}
