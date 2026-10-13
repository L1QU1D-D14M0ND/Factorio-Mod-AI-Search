import { loadConfig, type Config } from '../core/config.js';
import type { DB } from '../core/db/connection.js';
import { ThemeSearch } from '../core/embeddings/service.js';
import { createChatProvider, type ChatProvider } from '../core/llm/providers.js';

/**
 * Configuration-dependent services. Settings saved from the UI call reload(), so a new
 * AI provider or embedding model takes effect without restarting the server.
 */
export class Services {
  config!: Config;
  theme!: ThemeSearch;
  llm!: ChatProvider | { error: string };
  private embeddingsKey = '';

  constructor(
    private readonly db: DB,
    readonly cwd: string = process.cwd(),
    readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.reload();
  }

  reload(): void {
    this.config = loadConfig(this.cwd, this.env);
    // Keep the loaded embedding model unless its settings changed.
    const key = JSON.stringify(this.config.embeddings);
    if (key !== this.embeddingsKey) {
      this.theme = new ThemeSearch(this.db, this.config.embeddings);
      this.embeddingsKey = key;
    }
    this.llm = createChatProvider(this.config.llm);
  }
}
