/** `command` — a slash command and its completion candidates.
 *
 * Evaluated when the command palette opens, which is a keystroke, not a
 * stream.
 *
 * Engine commands need no code here beyond listing them: `/compact`, `/help`,
 * `/skills` and MCP prompts are intercepted by AttaCore inside the turn loop,
 * so sending the text as an ordinary message *is* the implementation. What
 * the point is really for is a command the interface answers itself, and a
 * command a plugin brings. */

export function commands(host) {
  const { t, state } = host;

  return [
    {
      id: "builtin.engine",
      /** Everything the engine already knows about: skills, built-ins,
       *  plugin commands, MCP prompts. Sent as a plain message. */
      complete(query) {
        return (state.commands || [])
          .filter((command) => command.name.toLowerCase().startsWith(query))
          .map((command) => ({
            replacement: `/${command.name} `,
            label: `/${command.name}`,
            description: command.description || "",
            source: command.source,
          }));
      },
    },
  ];
}
