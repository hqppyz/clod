import { join } from 'node:path';
import { Template } from './template';

// The data dir's prompt files for --append-system-prompt; each is undefined without its file
export class Prompts {
  constructor(private readonly data: string) {}

  // CONNECTORS.md, listing each connector's own prompt
  async system(connectors: readonly string[]): Promise<string | undefined> {
    const source = Bun.file(join(this.data, 'CONNECTORS.md'));
    if (!(await source.exists())) return undefined;
    return Template.fill(await source.text(), { CONNECTORS: connectors.join('\n') });
  }

  // CONNECTORS.<type>.md
  async connector(type: string, values: Readonly<Record<string, string>>): Promise<string | undefined> {
    const source = Bun.file(join(this.data, `CONNECTORS.${type}.md`));
    if (!(await source.exists())) return undefined;
    return Template.fill((await source.text()).trim(), values);
  }
}
