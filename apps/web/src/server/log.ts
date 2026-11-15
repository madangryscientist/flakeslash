/**
 * One line to the Worker's log. In a Worker the console is what Workers Logs reads, so this is the one
 * file that calls it; everything else takes `log` as an argument.
 */
export function log(line: string): void {
  console.log(line);
}
