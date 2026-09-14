const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:credentials?|secrets?|service[-_]?account)(?:\.|\/|$)/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /\.(?:pem|p12|pfx|key)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.yarnrc(?:\.yml)?$/i,
  /(^|\/)\.pnpmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)(?:\.aws|\.ssh|\.kube|\.config\/gcloud)(?:\/|$)/i,
];

export class ToolPolicy {
  static normalizeRelativePath(value: unknown) {
    const path = String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!path) throw Object.assign(new Error('Caminho obrigatório.'), { code:'invalid_path' });
    if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
      throw Object.assign(new Error('Caminho fora do workspace não é permitido.'), { code:'path_escape' });
    }
    return path;
  }

  static assertReadablePath(value: unknown) {
    const path = this.normalizeRelativePath(value);
    if (SENSITIVE_PATTERNS.some(pattern => pattern.test(path))) {
      throw Object.assign(new Error('Arquivo sensível bloqueado para leitura por ferramenta.'), { code:'sensitive_path' });
    }
    return path;
  }

  static isSensitivePath(path: string) {
    const normalized = String(path || '').replace(/\\/g,'/');
    return SENSITIVE_PATTERNS.some(pattern => pattern.test(normalized));
  }
}
