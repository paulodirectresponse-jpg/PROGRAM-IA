import { SecretService } from './secretService.js';
import { db } from '../db/index.js';

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
  visibility: 'public' | 'private';
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
  binaryFiles?: Record<string, Buffer>;
  error?: string;
}

export class GitHubService {
  static getToken(userId?: string): string | null {
    if (userId) {
      const userSecret = SecretService.getDecryptedSecret(userId, 'github');
      if (userSecret && userSecret.trim().length > 0) {
        return userSecret.trim();
      }
    }
    if (userId) return null;
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

  static async verifyConnection(userId?: string): Promise<GitHubConnectionStatus> {
    const token = this.getToken(userId);

    if (!token) {
      return {
        isConnected: false,
        status: 'pending_credentials',
        missingConfig: ['GITHUB_TOKEN'],
        message: 'Token do GitHub não configurado. Adicione seu token de acesso nas Integrações para habilitar sincronização.',
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
          message: 'O token do GitHub é inválido ou expirou.',
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

      const user = await res.json() as any;
      const scopesHeader = res.headers.get('x-oauth-scopes') || '';
      const scopes = scopesHeader ? scopesHeader.split(',').map((s: string) => s.trim()) : ['repo'];

      return {
        isConnected: true,
        status: 'connected',
        username: user.login,
        avatarUrl: user.avatar_url,
        scopes,
        missingConfig: [],
        message: `Conectado com sucesso como @${user.login}`,
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

  static async listUserRepos(userId?: string): Promise<{ success: boolean; repos?: GitHubRepoSummary[]; error?: string }> {
    const token = this.getToken(userId);
    if (!token) {
      return {
        success: false,
        error: 'Token do GitHub não configurado para o usuário.',
      };
    }

    try {
      const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator', {
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

      const repos = await res.json() as any[];
      return {
        success: true,
        repos: repos.map((r: any) => ({
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          private: Boolean(r.private),
          visibility: r.private ? 'private' : 'public',
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch || 'main',
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
    userId?: string;
    name: string;
    description: string;
    isPrivate: boolean;
  }): Promise<{ success: boolean; repo?: GitHubRepoSummary; error?: string }> {
    const token = this.getToken(options.userId);
    if (!token) {
      return {
        success: false,
        error: 'Token do GitHub não configurado. Cadastre sua credencial do GitHub antes de criar repositórios.',
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
        return { success: false, error: `Falha ao criar repositório no GitHub: ${errText.slice(0, 150)}` };
      }

      const r = await res.json() as any;
      return {
        success: true,
        repo: {
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          private: Boolean(r.private),
          visibility: r.private ? 'private' : 'public',
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch || 'main',
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
  static async importRepoFiles(
    owner: string,
    repo: string,
    branch: string = 'main',
    userId?: string
  ): Promise<GitHubImportResult> {
    const token = this.getToken(userId);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!repoRes.ok) {
        if (repoRes.status === 404) {
          return { success: false, error: `Repositório ${owner}/${repo} não encontrado no GitHub ou é privado.` };
        }
        return { success: false, error: `Erro ao acessar repositório no GitHub (HTTP ${repoRes.status})` };
      }
      const repoData = await repoRes.json() as any;
      const targetBranch = branch || repoData.default_branch || 'main';

      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${targetBranch}?recursive=1`,
        { headers }
      );

      if (!treeRes.ok) {
        return {
          success: false,
          error: `Falha ao listar arquivos da branch "${targetBranch}" no GitHub (HTTP ${treeRes.status}).`,
        };
      }

      const treeData = await treeRes.json() as any;
      const filesMap: Record<string, string> = {};
      const binaryFiles: Record<string, Buffer> = {};

      if (Array.isArray(treeData.tree)) {
        const textExtensions = ['.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.svg', '.txt'];
        const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf'];

        for (const item of treeData.tree) {
          if (item.type !== 'blob') continue;
          if (item.size > 2 * 1024 * 1024) continue; // Skip huge files > 2MB

          const isText = textExtensions.some(ext => item.path.toLowerCase().endsWith(ext));
          const isBinary = binaryExtensions.some(ext => item.path.toLowerCase().endsWith(ext));

          if (!isText && !isBinary) continue;

          try {
            // Fetch blob data via GitHub Git API
            const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${item.sha}`, { headers });
            if (blobRes.ok) {
              const blobData = await blobRes.json() as any;
              if (blobData.encoding === 'base64') {
                const buf = Buffer.from(blobData.content, 'base64');
                if (isBinary) {
                  binaryFiles[item.path] = buf;
                } else {
                  filesMap[item.path] = buf.toString('utf8');
                }
              }
            }
          } catch (e) {
            console.warn(`Falha ao carregar blob ${item.path}:`, e);
          }
        }
      }

      return {
        success: true,
        owner,
        repo,
        branch: targetBranch,
        filesCount: Object.keys(filesMap).length + Object.keys(binaryFiles).length,
        files: filesMap,
        binaryFiles,
      };
    } catch (err: any) {
      return { success: false, error: `Falha ao importar do GitHub: ${err.message}` };
    }
  }

  /**
   * Commit & Push workspace files to GitHub
   */
  static async pushFilesToRepo(options: {
    userId?: string;
    owner: string;
    repo: string;
    branch: string;
    commitMessage: string;
    files: Record<string, string>;
  }): Promise<{ success: boolean; commitSha?: string; error?: string }> {
    const token = this.getToken(options.userId);
    if (!token) {
      return {
        success: false,
        error: 'Token do GitHub não configurado.',
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
      // 1. Get current branch reference
      const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers });
      if (!refRes.ok) {
        return { success: false, error: `Branch ${branch} não encontrada no repositório remoto.` };
      }
      const refData = await refRes.json() as any;
      const latestCommitSha = refData.object.sha;

      // 2. Get the base tree
      const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${latestCommitSha}`, { headers });
      const commitData = await commitRes.json() as any;
      const baseTreeSha = commitData.tree.sha;

      // 3. Create blobs & tree items, including deletions for remote files absent locally.
      const treeItems: any[] = [];
      const localPaths = new Set(Object.keys(files).map((filePath) => filePath.replace(/\\/g, '/')));
      const currentTreeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`, { headers });
      if (currentTreeRes.ok) {
        const currentTree = await currentTreeRes.json() as any;
        for (const item of currentTree.tree || []) {
          if (item.type === 'blob' && !localPaths.has(String(item.path))) {
            treeItems.push({ path: item.path, mode: '100644', type: 'blob', sha: null });
          }
        }
      }

      for (const [filePath, content] of Object.entries(files)) {
        const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            content,
            encoding: 'utf-8',
          }),
        });

        if (!blobRes.ok) {
          const errText = await blobRes.text();
          return { success: false, error: `Erro ao criar blob para ${filePath}: ${errText.slice(0, 100)}` };
        }

        const blobData = await blobRes.json() as any;
        treeItems.push({
          path: filePath.replace(/\\/g, '/'),
          mode: '100644',
          type: 'blob',
          sha: blobData.sha,
        });
      }

      // 4. Create tree
      const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeItems,
        }),
      });

      if (!treeRes.ok) {
        const errText = await treeRes.text();
        return { success: false, error: `Erro ao criar árvore Git: ${errText.slice(0, 100)}` };
      }

      const newTreeData = await treeRes.json() as any;

      // 5. Create commit
      const newCommitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: commitMessage,
          tree: newTreeData.sha,
          parents: [latestCommitSha],
        }),
      });

      if (!newCommitRes.ok) {
        const errText = await newCommitRes.text();
        return { success: false, error: `Erro ao gerar commit: ${errText.slice(0, 100)}` };
      }

      const newCommitData = await newCommitRes.json() as any;

      // 6. Update branch ref
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
        return { success: false, error: `Erro ao atualizar branch ${branch}: ${errText.slice(0, 100)}` };
      }

      return {
        success: true,
        commitSha: newCommitData.sha,
      };
    } catch (err: any) {
      return { success: false, error: `Falha no push: ${err.message}` };
    }
  }

  static async createPullRequest(options: {
    userId?: string;
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
  }): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
    const token = this.getToken(options.userId);
    if (!token) {
      return { success: false, error: 'Token do GitHub não configurado.' };
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

      const pr = await res.json() as any;
      return {
        success: true,
        prUrl: pr.html_url,
        prNumber: pr.number,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  static async listBranches(owner: string, repo: string, userId?: string): Promise<{ success: boolean; branches?: string[]; defaultBranch?: string; error?: string }> {
    const token = this.getToken(userId);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, { headers });
      if (!res.ok) {
        return { success: false, error: `Falha ao listar branches (HTTP ${res.status})` };
      }
      const data = await res.json() as any[];
      return { success: true, branches: data.map((b: any) => b.name) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  static async createBranch(options: {
    userId?: string;
    owner: string;
    repo: string;
    newBranch: string;
    fromBranch?: string;
  }): Promise<{ success: boolean; branch?: string; baseSha?: string; error?: string }> {
    const token = this.getToken(options.userId);
    if (!token) return { success: false, error: 'Token do GitHub não configurado.' };

    const { owner, repo, newBranch, fromBranch = 'main' } = options;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
      'Content-Type': 'application/json',
    };

    try {
      const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`, { headers });
      if (!refRes.ok) {
        return { success: false, error: `Branch base "${fromBranch}" não encontrada no repositório.` };
      }
      const refData = await refRes.json() as any;
      const baseSha = refData.object.sha;

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

      return { success: true, branch: newBranch, baseSha };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Compare local status vs remote branch with TRUTHFUL comparison
   * Never returns 'clean' without verified matching commit SHAs!
   */
  static async getSyncStatus(options: {
    userId?: string;
    projectId?: string;
    owner: string;
    repo: string;
    branch: string;
    localHeadSha?: string;
  }): Promise<{
    success: boolean;
    syncStatus?: 'clean' | 'ahead' | 'behind' | 'diverged' | 'unknown';
    latestRemoteCommit?: { sha: string; message: string; date: string; author: string };
    error?: string;
  }> {
    const token = this.getToken(options.userId);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ForgeAgent-Workspace/1.0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetch(`https://api.github.com/repos/${options.owner}/${options.repo}/commits/${options.branch}`, { headers });
      if (!res.ok) {
        return { success: false, error: `Não foi possível verificar status da branch remota (${res.status}).` };
      }

      const commit = await res.json() as any;
      const remoteSha = commit.sha;

      // Determine local commit SHA from database branch record if not explicitly provided
      let localSha = options.localHeadSha;
      if (!localSha && options.projectId) {
        const branchRow = db.prepare('SELECT head_commit_hash FROM branches WHERE project_id = ? AND name = ?').get(options.projectId, options.branch) as any;
        localSha = branchRow?.head_commit_hash;
      }

      let status: 'clean' | 'ahead' | 'behind' | 'diverged' | 'unknown' = 'unknown';

      if (!localSha) {
        status = 'behind'; // Local hasn't synced yet
      } else if (localSha === remoteSha) {
        status = 'clean'; // Truly identical
      } else if (token) {
        // Use GitHub compare API to accurately detect ahead vs behind vs diverged
        try {
          const compRes = await fetch(`https://api.github.com/repos/${options.owner}/${options.repo}/compare/${localSha}...${remoteSha}`, { headers });
          if (compRes.ok) {
            const compData = await compRes.json() as any;
            if (compData.status === 'identical') status = 'clean';
            else if (compData.status === 'ahead') status = 'behind'; // remote is ahead of local
            else if (compData.status === 'behind') status = 'ahead'; // remote is behind local
            else if (compData.status === 'diverged') status = 'diverged';
          } else {
            status = 'unknown';
          }
        } catch {
          status = 'unknown';
        }
      } else {
        status = 'unknown';
      }

      return {
        success: true,
        syncStatus: status,
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

