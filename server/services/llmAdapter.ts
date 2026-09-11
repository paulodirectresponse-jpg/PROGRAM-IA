import { GoogleGenAI } from '@google/genai';
import { db } from '../db/index.js';

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

export interface BuildOutput {
  summary: string;
  explanation: string;
  files: Array<{
    path: string;
    action: 'create' | 'modify' | 'delete';
    content: string;
  }>;
}

export interface LLMExecutionResult {
  replyText: string;
  mode: 'plan' | 'build' | 'review' | 'publish';
  isDemonstrativeFallback: boolean;
  providerUsed: string;
  modelUsed: string;
  plan?: PlanOutput;
  build?: BuildOutput;
}

export class LLMAdapterService {
  /**
   * Determine available configured provider
   */
  static getActiveProviderConfig() {
    const openaiKey = process.env.OPENAI_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (openaiKey && openaiKey.trim().length > 0) {
      return {
        type: 'openai_compatible' as const,
        apiKey: openaiKey,
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.useoneai.app/v1',
        modelId: process.env.OPENAI_MODEL_ID || 'chatgpt-5.5',
        name: 'UseOneAI / OpenAI-Compatible',
      };
    }

    if (geminiKey && geminiKey.trim().length > 0) {
      return {
        type: 'gemini' as const,
        apiKey: geminiKey,
        baseUrl: 'https://generativelanguage.googleapis.com',
        modelId: 'gemini-2.5-flash',
        name: 'Google Gemini',
      };
    }

    return null;
  }

  /**
   * Execute task across Plan, Build, Review, or Publish modes
   */
  static async executePrompt(options: {
    prompt: string;
    mode: 'plan' | 'build' | 'review' | 'publish';
    projectId: string;
    existingFiles: Record<string, string>;
    appliedSkills: string[];
    conversationHistory: Array<{ sender: string; content: string }>;
  }): Promise<LLMExecutionResult> {
    const { prompt, mode, appliedSkills, existingFiles, conversationHistory } = options;
    const providerConfig = this.getActiveProviderConfig();

    // Context injection
    const skillsText = appliedSkills.length > 0 ? `\nSkills Ativas: ${appliedSkills.join(', ')}.` : '';
    const filesList = Object.keys(existingFiles).join(', ') || 'Nenhum arquivo ainda criado.';

    // If an active real provider is configured, try calling it
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
        // Fallback with explicit error note
        const fallback = this.generateDemonstrativeFallback(prompt, mode, existingFiles, appliedSkills);
        fallback.replyText = `⚠️ **Falha na comunicação com ${providerConfig.name} (${providerConfig.modelId})**: ${err.message || 'Erro de conexão'}.\n\n` + fallback.replyText;
        return fallback;
      }
    }

    // Explicit demonstrative fallback when no keys are configured
    return this.generateDemonstrativeFallback(prompt, mode, existingFiles, appliedSkills);
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
    const content = data.choices?.[0]?.message?.content || '';

    return this.parseLLMResponse(content, context.mode, config.name, config.modelId);
  }

  private static async callGemini(
    config: { apiKey: string; modelId: string; name: string },
    context: any
  ): Promise<LLMExecutionResult> {
    const ai = new GoogleGenAI({ apiKey: config.apiKey });
    const systemPrompt = this.buildSystemPrompt(context.mode, context.skillsText, context.filesList, context.existingFiles);

    const fullPrompt = `${systemPrompt}\n\nHistórico Recente:\n${context.conversationHistory.slice(-4).map((h: any) => `${h.sender}: ${h.content}`).join('\n')}\n\nUsuário: ${context.prompt}`;

    const res = await ai.models.generateContent({
      model: config.modelId,
      contents: fullPrompt,
    });

    const content = res.text || '';
    return this.parseLLMResponse(content, context.mode, config.name, config.modelId);
  }

  private static buildSystemPrompt(mode: string, skillsText: string, filesList: string, existingFiles: Record<string, string>) {
    return `Você é o Forge Agent, uma inteligência especializada em engenharia de software full-stack.
Modo Atual: ${mode.toUpperCase()}.
${skillsText}
Arquivos existentes no workspace: [${filesList}].

Regras estritas:
1. Responda em português claro e objetivo.
2. ${
      mode === 'plan'
        ? `No modo PLANEJAR, gere um plano técnico em JSON dentro de um bloco \`\`\`json { "objective": string, "scope_in": string, "scope_out": string, "files_affected": string[], "integrations": string[], "risks": string[], "acceptance_criteria": string[] } \`\`\` seguido de uma explicação elegante.`
        : mode === 'build'
        ? `No modo CONSTRUIR, retorne as alterações de código diretamente em um bloco \`\`\`json { "summary": string, "explanation": string, "files": [ { "path": string, "action": "create"|"modify", "content": string } ] } \`\`\` para que os arquivos sejam criados no workspace e exibidos no live preview.`
        : `No modo REVISÃO ou PUBLICAÇÃO, forneça auditoria técnica, critérios de aceite e próximos passos.`
    }
`;
  }

  private static parseLLMResponse(content: string, mode: 'plan' | 'build' | 'review' | 'publish', providerName: string, modelId: string): LLMExecutionResult {
    let plan: PlanOutput | undefined;
    let build: BuildOutput | undefined;

    // Try extracting JSON block if present
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (mode === 'plan' && parsed.objective) {
          plan = parsed;
        } else if (mode === 'build' && parsed.files) {
          build = parsed;
        }
      } catch (e) {
        console.warn('Falha ao interpretar bloco JSON da IA:', e);
      }
    }

    return {
      replyText: content,
      mode,
      isDemonstrativeFallback: false,
      providerUsed: providerName,
      modelUsed: modelId,
      plan,
      build,
    };
  }

  /**
   * Deterministic demonstrative fallback when no API key is available or during offline execution
   */
  static generateDemonstrativeFallback(
    prompt: string,
    mode: 'plan' | 'build' | 'review' | 'publish',
    existingFiles: Record<string, string>,
    appliedSkills: string[]
  ): LLMExecutionResult {
    const notice = `> ℹ️ **[MODO DEMONSTRATIVO: Provedor de IA não configurado ou sem chave ativa]**\n> Nenhuma chave foi encontrada em \`OPENAI_API_KEY\` ou \`GEMINI_API_KEY\`. Para habilitar chamadas reais de IA pelo UseOneAI ou Gemini, acesse a aba **Provedores** na barra lateral e configure suas credenciais seguras no servidor.\n\n`;

    if (mode === 'plan') {
      const plan: PlanOutput = {
        objective: `Implementar solicitação: "${prompt.slice(0, 80)}"`,
        scope_in: 'Criação de componentes reativos, estilos integrados e layout adaptativo no sandbox.',
        scope_out: 'Deploy externo em nuvem ou bancos remotos de terceiros nesta iteração.',
        files_affected: ['index.html', 'app.js', 'styles.css'],
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
${plan.acceptance_criteria.map(c => `  - [ ] ${c}`).join('\n')}

Revise os detalhes acima. Clique no botão **"Aprovar Plano"** ou alterne para o modo **Construir** para gerar o código e atualizar o preview ao vivo.`;

      return {
        replyText,
        mode: 'plan',
        isDemonstrativeFallback: true,
        providerUsed: 'Forge Local Fallback Engine',
        modelUsed: 'deterministic-plan-v1',
        plan,
      };
    }

    if (mode === 'build') {
      // Generate updated interactive app in index.html tailored to the user prompt
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

    <!-- Interactive Interactive List Panel -->
    <div class="p-5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-slate-200">Gerenciador de Itens Dinâmicos</h2>
        <div class="flex gap-2">
          <input id="item-input" type="text" placeholder="Adicionar novo registro..." class="px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500 w-52" />
          <button id="btn-add" class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 transition">
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

      const build: BuildOutput = {
        summary: `Atualizei a estrutura de arquivos no sandbox para atender: "${prompt.slice(0, 60)}"`,
        explanation: 'Arquivo index.html regenerado com componentes interativos, Tailwind CSS estilizado em modo escuro e scripts de manipulação de estado local.',
        files: [
          {
            path: 'index.html',
            action: 'modify',
            content: newHtml,
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

Tudo pronto para publicação ou para uma nova solicitação no modo **Construir**.`;

      return {
        replyText,
        mode: 'review',
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
      isDemonstrativeFallback: true,
      providerUsed: 'Forge Local Fallback Engine',
      modelUsed: 'deterministic-publish-v1',
    };
  }
}
