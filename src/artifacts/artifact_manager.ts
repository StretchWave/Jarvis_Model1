import * as fs from "node:fs";
import * as path from "node:path";
import { Database, type ArtifactRecord } from "../database.ts";
import { Logger } from "../logger.ts";

export type ArtifactType =
  | "report"
  | "document"
  | "code_patch"
  | "file"
  | "research_note"
  | "screenshot"
  | string;

export interface CreateArtifactParams {
  runId: string;
  sessionId: string;
  type: ArtifactType;
  description: string;
  path?: string;
  content?: string;
}

export interface ListArtifactsFilter {
  sessionId?: string;
  runId?: string;
  type?: string;
  limit?: number;
}

export class ArtifactManager {
  private db: Database;
  private logger: Logger;
  private storageDir: string;

  constructor(db: Database, logger: Logger, storageDir?: string) {
    this.db = db;
    this.logger = logger.forComponent("ArtifactManager");
    this.storageDir = storageDir || path.join(process.cwd(), ".jarvis_data", "artifacts");

    if (!fs.existsSync(this.storageDir)) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
      } catch (err) {
        this.logger.warn(`Failed to create artifact storage dir ${this.storageDir}:`, err);
      }
    }
  }

  /**
   * Creates and registers a new artifact generated during task execution.
   */
  public createArtifact(params: CreateArtifactParams): ArtifactRecord {
    const id = `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let artifactPath = params.path;

    // Persist content to file if provided
    if (params.content) {
      if (!artifactPath) {
        const ext = this.getExtensionForType(params.type);
        artifactPath = path.join(this.storageDir, `${id}${ext}`);
      }

      try {
        const dir = path.dirname(artifactPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(artifactPath, params.content, "utf-8");
        this.logger.debug(`Artifact content persisted to file: ${artifactPath}`);
      } catch (err) {
        this.logger.error(`Failed to write artifact file to ${artifactPath}:`, err);
      }
    }

    const rec: ArtifactRecord = {
      id,
      run_id: params.runId,
      session_id: params.sessionId,
      type: params.type,
      path: artifactPath,
      description: params.description,
      content: params.content,
      created_at: Date.now(),
    };

    this.db.recordArtifact(rec);
    this.logger.info(`Recorded artifact ${id} (${rec.type}): ${rec.description}`);
    return rec;
  }

  /**
   * Retrieves an artifact by its unique ID.
   */
  public getArtifact(id: string): ArtifactRecord | null {
    return this.db.getArtifact(id);
  }

  /**
   * Lists artifacts matching the optional filter criteria.
   */
  public listArtifacts(filter?: ListArtifactsFilter): ArtifactRecord[] {
    const records = this.db.listArtifacts(filter?.sessionId, filter?.runId, filter?.limit || 50);
    if (filter?.type) {
      return records.filter((r) => r.type.toLowerCase() === filter.type!.toLowerCase());
    }
    return records;
  }

  /**
   * Exports or copies an artifact to an explicit destination path.
   */
  public exportArtifact(id: string, destinationPath: string): boolean {
    const artifact = this.getArtifact(id);
    if (!artifact) {
      this.logger.warn(`Cannot export artifact: ${id} not found`);
      return false;
    }

    try {
      const dir = path.dirname(destinationPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (artifact.content) {
        fs.writeFileSync(destinationPath, artifact.content, "utf-8");
        return true;
      } else if (artifact.path && fs.existsSync(artifact.path)) {
        fs.copyFileSync(artifact.path, destinationPath);
        return true;
      }

      this.logger.warn(`Artifact ${id} has neither content nor valid file path`);
      return false;
    } catch (err) {
      this.logger.error(`Export failed for artifact ${id} to ${destinationPath}:`, err);
      return false;
    }
  }

  /**
   * Formats a clean, readable summary of artifacts for assistant responses or inspector views.
   */
  public formatArtifactSummary(artifacts: ArtifactRecord[]): string {
    if (!artifacts || artifacts.length === 0) {
      return "No artifacts recorded.";
    }

    const lines = [`### Generated Artifacts (${artifacts.length}):`];
    for (const art of artifacts) {
      const loc = art.path ? ` [${art.path}]` : "";
      lines.push(`- **[${art.type.toUpperCase()}]** ${art.description}${loc} (ID: \`${art.id}\`)`);
    }
    return lines.join("\n");
  }

  private getExtensionForType(type: string): string {
    switch (type.toLowerCase()) {
      case "report":
      case "research_note":
        return ".md";
      case "code_patch":
        return ".patch";
      case "document":
        return ".txt";
      case "screenshot":
        return ".png";
      default:
        return ".txt";
    }
  }
}
