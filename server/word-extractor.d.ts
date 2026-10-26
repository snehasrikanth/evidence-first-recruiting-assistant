declare module "word-extractor" {
  interface ExtractedDocument {
    getBody(): string;
  }

  export default class WordExtractor {
    extract(source: Buffer | string): Promise<ExtractedDocument>;
  }
}
