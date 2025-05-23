export function cleanMessage(content: string): string {
    return content
        .split('\n') // Split message into lines
        .filter(line => !line.trimStart().startsWith('>')) // Remove blockquote lines with optional spaces before '>'
        .join('\n') // Join the remaining lines
        .trim() || '** **'; // Return fallback if everything was removed
}
