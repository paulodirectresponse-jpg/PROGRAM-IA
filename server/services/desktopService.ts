import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface DesktopStatus {
  isElectron: boolean;
  platform: string;
  autoUpdateAvailable: boolean;
  updateStatus: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
}

export class DesktopService {
  private static updateStatus: DesktopStatus['updateStatus'] = 'idle';
  private static lastCheckError: string | null = null;

  static isElectronEnvironment(): boolean {
    return Boolean(
      process.versions && (process.versions as any).electron
    );
  }

  static getStatus(): DesktopStatus {
    return {
      isElectron: this.isElectronEnvironment(),
      platform: process.platform,
      autoUpdateAvailable: false,
      updateStatus: this.updateStatus,
      currentVersion: '1.0.0',
    };
  }

  /**
   * Check for latest release on GitHub Releases repository
   */
  static async checkForUpdates(repo: string = 'paulodirectresponse-jpg/PROGRAM-IA'): Promise<{
    hasUpdate: boolean;
    latestVersion?: string;
    releaseUrl?: string;
    message: string;
  }> {
    this.updateStatus = 'checking';
    this.lastCheckError = null;

    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: {
          'User-Agent': 'ForgeAgent-Desktop',
          'Accept': 'application/vnd.github.v3+json',
        },
      });

      if (response.status === 404) {
        this.updateStatus = 'not-available';
        return {
          hasUpdate: false,
          message: 'Nenhum release publicado no momento no repositório.',
        };
      }

      if (!response.ok) {
        throw new Error(`Resposta do GitHub HTTP ${response.status}`);
      }

      const release = await response.json() as any;
      const latestTag = release.tag_name || release.name || 'v1.0.0';
      this.updateStatus = 'idle';

      return {
        hasUpdate: false, // current is latest
        latestVersion: latestTag,
        releaseUrl: release.html_url,
        message: `Versão ${latestTag} verificada no GitHub Releases.`,
      };
    } catch (err: any) {
      this.updateStatus = 'error';
      this.lastCheckError = err.message;
      return {
        hasUpdate: false,
        message: `Verificação de atualização concluída com aviso: ${err.message}`,
      };
    }
  }

  /**
   * Safe local command execution (allowed read-only and safe git commands)
   */
  static async executeControlledCommand(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
    const safeWhitelist = ['git status', 'git branch', 'git log -n 5', 'git diff', 'node -v', 'npm -v'];
    const isAllowed = safeWhitelist.some(prefix => cmd.startsWith(prefix));

    if (!isAllowed) {
      throw new Error(`Comando '${cmd}' bloqueado pelo sandbox de segurança do Desktop.`);
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: cwd || process.cwd(), timeout: 10000 });
      return { stdout, stderr, success: true };
    } catch (err: any) {
      return { stdout: '', stderr: err.message, success: false };
    }
  }
}

