/** A failure of this sentence's generation, not of capture or the model pool. */
export class TranslationLimitError extends Error {
  constructor(message = '译文达到长度上限，已保留部分内容。请缩短原文后重试。') {
    super(message);
    this.name = 'TranslationLimitError';
  }
}
