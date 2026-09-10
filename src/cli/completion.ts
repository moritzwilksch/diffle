import { type Command, Option } from 'commander';
import { generateCompletion, type Shell } from 'commander-static-completion';

const SHELLS = ['bash', 'zsh', 'fish'] as const satisfies readonly Shell[];

/**
 * Adds `diffle completion --shell <shell>`, which prints a standalone script derived from
 * this command tree. The script completes in the shell alone: tab completion never starts
 * node, so it stays fast, and it goes stale until the command is run again after an upgrade.
 */
export function addCompletionCommand(program: Command): Command {
  return program
    .command('completion')
    .description('print a shell completion script for bash, zsh, or fish')
    .addOption(
      new Option('-s, --shell <shell>', 'shell to generate the script for').choices(SHELLS).makeOptionMandatory(),
    )
    .addHelpText(
      'after',
      `
Install it for the current user, then start a new shell:
  bash  diffle completion --shell bash > ~/.local/share/bash-completion/completions/diffle
  zsh   diffle completion --shell zsh > ~/.local/share/zsh/site-functions/_diffle
        (any directory that .zshrc puts on fpath before compinit)
  fish  diffle completion --shell fish > ~/.config/fish/completions/diffle.fish

Run it again after upgrading diffle: the script is static, so new options do not appear on their own.`,
    )
    .action((opts: { shell: Shell }) => {
      process.stdout.write(generateCompletion(program, { shell: opts.shell }));
    });
}
