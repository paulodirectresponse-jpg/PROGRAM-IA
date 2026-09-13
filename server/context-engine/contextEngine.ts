import { ArchitectureGraphService } from './architectureGraph.js';
import { ContextCommitService } from './contextCommit.js';
import { ContextCompiler } from './contextCompiler.js';
import { ProjectFileIndex } from './projectFileIndex.js';
import type { ContextCommitInput, ContextCompileInput } from './types.js';

export class ContextEngineV2 {
  static syncProject(input: {projectId:string;files:Record<string,string>}) {
    const sync = ProjectFileIndex.syncProject(input.projectId, input.files);
    const previous = ArchitectureGraphService.latest(input.projectId);
    const graph = (!previous || sync.changedPaths.length > 0 || sync.removedPaths.length > 0)
      ? ArchitectureGraphService.buildAndPersist(input.projectId)
      : previous;
    return {sync,graph};
  }

  static compile(input: ContextCompileInput) {
    return ContextCompiler.compile(input);
  }

  static recordCommit(input: ContextCommitInput) {
    return ContextCommitService.create(input);
  }

  static snapshot(projectId: string) {
    return {
      files:ProjectFileIndex.list(projectId),
      architecture:ArchitectureGraphService.latest(projectId),
      commits:ContextCommitService.listRecent(projectId,50),
      telemetry:ContextCompiler.listTelemetry(projectId,50),
    };
  }
}

export * from './types.js';
export { ProjectFileIndex } from './projectFileIndex.js';
export { ArchitectureGraphService } from './architectureGraph.js';
export { ContextCommitService } from './contextCommit.js';
export { ContextCompiler } from './contextCompiler.js';
