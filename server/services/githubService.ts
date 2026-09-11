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

export interface GitHubImportResult {
  success: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  filesCount?: number;
  files?: Record<string, string>;
  error?: string;
}

export class GitHubService {
  static getToken(): string | null {
    const token = process.env.GITHUB_TOKEN;
    if (!token || token.trim().length === 0 || token.includes('MY_GITHUB_TOKEN')) {
      return null;
    }
    return token.trim();
  }

  static parseRepoUrl(url: string): { owner: string; repo: string } | null {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    const match =
      trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git|\/)?$/) ||
      trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    return null;
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
      const scopes = scopesHeader ? scopesHeader.split(',').map((s) => s.trim()) : ['repo'];

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

  /**
   * Import repository files from GitHub REST API
   */
  static async importRepoFiles(owner: string, repo: string, branch: string = 'main'): Promise<GitHubImportResult> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      // 1. Get repo details to get default branch if needed
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!repoRes.ok) {
        if (repoRes.status === 404) {
          return { success: false, error: `Repositório ${owner}/${repo} não encontrado no GitHub ou é privado.` };
        }
        return { success: false, error: `Erro ao acessar repositório no GitHub (HTTP ${repoRes.status})` };
      }
      const repoData = await repoRes.json();
      const targetBranch = branch || repoData.default_branch || 'main';

      // 2. Fetch Git tree recursively
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${targetBranch}?recursive=1`,
        { headers }
      );

      if (!treeRes.ok) {
        return {
          success: false,
          error: `Falha ao listar árvore de arquivos da branch "${targetBranch}" no GitHub (HTTP ${treeRes.status}).`,
        };
      }

      const treeData = await treeRes.json();
      const filesMap: Record<string, string> = {};

      if (Array.isArray(treeData.tree)) {
        // Filter text/web files, maximum 30 files for responsiveness
        const textExtensions = ['.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.svg', '.txt'];
        const candidateFiles = treeData.tree.filter(
          (item: any) =>
            item.type === 'blob' &&
            item.size < 200000 &&
            textExtensions.some((ext) => item.path.toLowerCase().endsWith(ext))
        );

        const filesToFetch = candidateFiles.slice(0, 30);

        for (const item of filesToFetch) {
          try {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${targetBranch}/${item.path}`;
            const rawRes = await fetch(rawUrl, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (rawRes.ok) {
              filesMap[item.path] = await rawRes.text();
            }
          } catch (e) {
            console.warn(`Falha ao carregar arquivo ${item.path} do GitHub:`, e);
          }
        }
      }

      return {
        success: true,
        owner,
        repo,
        branch: targetBranch,
        filesCount: Object.keys(filesMap).length,
        files: filesMap,
      };
    } catch (err: any) {
      return { success: false, error: `Falha ao importar do GitHub: ${err.message}` };
    }
  }

  /**
   * Commit & Push workspace files to GitHub
   */
  static async pushFilesToRepo(options: {
    owner: string;
    repo: string;
    branch: string;
    commitMessage: string;
    files: Record<string, string>;
  }): Promise<{ success: boolean; commitSha?: string; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return {
        success: false,
        error: 'GITHUB_TOKEN não configurado no servidor. Configure a variável no painel para realizar push.',
      };
    }

    const { owner, repo, branch, commitMessage, files } = options;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
      'Content-Type': 'application/json',
    };

    try {
      // 1. Get branch reference
      const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers });
      if (!refRes.ok) {
        return { success: false, error: `Branch "${branch}" não encontrada no repositório ${owner}/${repo}` };
      }
      const refData = await refRes.json();
      const latestCommitSha = refData.object.sha;

      // 2. Get latest commit
      const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${latestCommitSha}`, {
        headers,
      });
      const commitData = await commitRes.json();
      const baseTreeSha = commitData.tree.sha;

      // 3. Create tree items
      const treeItems = Object.entries(files).map(([path, content]) => ({
        path,
        mode: '100644',
        type: 'blob',
        content,
      }));

      const newTreeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeItems,
        }),
      });

      if (!newTreeRes.ok) {
        const errText = await newTreeRes.text();
        return { success: false, error: `Erro ao criar Git Tree: ${errText.slice(0, 150)}` };
      }

      const newTreeData = await newTreeRes.json();

      // 4. Create commit
      const newCommitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: commitMessage || 'Alterações aplicadas via Forge Agent',
          tree: newTreeData.sha,
          parents: [latestCommitSha],
        }),
      });

      if (!newCommitRes.ok) {
        const errText = await newCommitRes.text();
        return { success: false, error: `Erro ao criar Git Commit: ${errText.slice(0, 150)}` };
      }

      const newCommitData = await newCommitRes.json();

      // 5. Update branch reference
      const updateRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          sha: newCommitData.sha,
          force: false,
        }),
      });

      if (!updateRefRes.ok) {
        const errText = await updateRefRes.text();
        return { success: false, error: `Erro ao atualizar branch ${branch}: ${errText.slice(0, 150)}` };
      }

      return {
        success: true,
        commitSha: newCommitData.sha,
      };
    } catch (err: any) {
      return { success: false, error: `Falha no push: ${err.message}` };
    }
  }

  /**
   * Create Pull Request on GitHub
   */
  static async createPullRequest(options: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
  }): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return {
        success: false,
        error: 'GITHUB_TOKEN não configurado no servidor.',
      };
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${options.owner}/${options.repo}/pulls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ForgeAgent-Workspace/1.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: options.title,
          head: options.head,
          base: options.base,
          body: options.body || 'Criado via Forge Agent',
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, error: `Falha ao criar Pull Request: ${errText.slice(0, 150)}` };
      }

      const pr = await res.json();
      return {
        success: true,
        prUrl: pr.html_url,
        prNumber: pr.number,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * List branches in a repository
   */
  static async listBranches(owner: string, repo: string): Promise<{ success: boolean; branches?: string[]; defaultBranch?: string; error?: string }> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, { headers });
      if (!res.ok) {
        return { success: false, error: `Falha ao listar branches (HTTP ${res.status})` };
      }
      const data = await res.json();
      const branches = data.map((b: any) => b.name);
      return { success: true, branches };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Create a new branch in a repository
   */
  static async createBranch(options: {
    owner: string;
    repo: string;
    newBranch: string;
    fromBranch?: string;
  }): Promise<{ success: boolean; branch?: string; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return { success: false, error: 'GITHUB_TOKEN não configurado no servidor.' };
    }

    const { owner, repo, newBranch, fromBranch = 'main' } = options;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
      'Content-Type': 'application/json',
    };

    try {
      // 1. Get SHA of base branch
      const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`, { headers });
      if (!refRes.ok) {
        return { success: false, error: `Branch base "${fromBranch}" não encontrada no repositório.` };
      }
      const refData = await refRes.json();
      const baseSha = refData.object.sha;

      // 2. Create ref for new branch
      const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ref: `refs/heads/${newBranch}`,
          sha: baseSha,
        }),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        return { success: false, error: `Falha ao criar branch "${newBranch}": ${errText.slice(0, 150)}` };
      }

      return { success: true, branch: newBranch };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Compare local status vs remote branch
   */
  static async getSyncStatus(options: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<{
    success: boolean;
    syncStatus?: 'clean' | 'ahead' | 'behind' | 'diverged' | 'unknown';
    latestRemoteCommit?: { sha: string; message: string; date: string; author: string };
    error?: string;
  }> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${options.owner}/${options.repo}/commits/${options.branch}`, { headers });
      if (!res.ok) {
        return { success: false, error: `Não foi possível verificar status da branch remota (${res.status}).` };
      }

      const commit = await res.json();
      return {
        success: true,
        syncStatus: 'clean',
        latestRemoteCommit: {
          sha: commit.sha.substring(0, 7),
          message: commit.commit.message,
          date: commit.commit.author.date,
          author: commit.commit.author.name,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
