export interface GitHubConnectionStatus {
  isConnected: boolean;
  status: 'connected' | 'pending_credentials' | 'invalid_token' | 'rate_limited';
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
  missingConfig: string[];
  message: string;
}

export interface GitHubRepoSummary {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  description: string | null;
}

export class GitHubService {
  static getToken(): string | null {
    const token = process.env.GITHUB_TOKEN;
    if (!token || token.trim().length === 0 || token.includes('MY_GITHUB_TOKEN')) {
      return null;
    }
    return token.trim();
  }

  static async verifyConnection(): Promise<GitHubConnectionStatus> {
    const token = this.getToken();

    if (!token) {
      return {
        isConnected: false,
        status: 'pending_credentials',
        missingConfig: ['GITHUB_TOKEN'],
        message: 'GITHUB_TOKEN não configurado nas variáveis de ambiente do servidor. Adicione seu token de acesso pessoal para habilitar sincronização real com o GitHub.',
      };
    }

    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ForgeAgent-Workspace/1.0',
        },
      });

      if (res.status === 401) {
        return {
          isConnected: false,
          status: 'invalid_token',
          missingConfig: [],
          message: 'O token fornecido em GITHUB_TOKEN é inválido ou expirou.',
        };
      }

      if (!res.ok) {
        return {
          isConnected: false,
          status: 'invalid_token',
          missingConfig: [],
          message: `Erro da API do GitHub: HTTP ${res.status}`,
        };
      }

      const user = await res.json();
      const scopesHeader = res.headers.get('x-oauth-scopes') || '';
      const scopes = scopesHeader ? scopesHeader.split(',').map(s => s.trim()) : ['repo'];

      return {
        isConnected: true,
        status: 'connected',
        username: user.login,
        avatarUrl: user.avatar_url,
        scopes,
        missingConfig: [],
        message: `Conectado autenticado com sucesso como @${user.login}`,
      };
    } catch (err: any) {
      return {
        isConnected: false,
        status: 'invalid_token',
        missingConfig: [],
        message: `Falha na conexão de rede com a API do GitHub: ${err.message}`,
      };
    }
  }

  static async listUserRepos(): Promise<{ success: boolean; repos?: GitHubRepoSummary[]; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return {
        success: false,
        error: 'GITHUB_TOKEN não configurado no servidor.',
      };
    }

    try {
      const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=30', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ForgeAgent-Workspace/1.0',
        },
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          success: false,
          error: `Erro ao buscar repositórios (${res.status}): ${errorText.slice(0, 150)}`,
        };
      }

      const repos = await res.json();
      return {
        success: true,
        repos: repos.map((r: any) => ({
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch,
          description: r.description,
        })),
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Falha ao comunicar com GitHub',
      };
    }
  }

  static async createRepository(options: {
    name: string;
    description: string;
    isPrivate: boolean;
  }): Promise<{ success: boolean; repo?: GitHubRepoSummary; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return {
        success: false,
        error: 'GITHUB_TOKEN não configurado no servidor. Configure a variável no painel ou em .env antes de criar o repositório.',
      };
    }

    try {
      const res = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ForgeAgent-Workspace/1.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: options.name,
          description: options.description || 'Criado via Forge Agent',
          private: options.isPrivate,
          auto_init: true,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, error: `Falha ao criar repositório no GitHub: ${errText}` };
      }

      const r = await res.json();
      return {
        success: true,
        repo: {
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch,
          description: r.description,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
