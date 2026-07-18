import { getEncoding, type Tiktoken } from 'js-tiktoken';

let enc: Tiktoken | null = null;
export function countTokens(text: string): number {
  if (text === '') return 0;
  if (!enc) enc = getEncoding('o200k_base');
  return enc.encode(text).length;
}
