export const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
