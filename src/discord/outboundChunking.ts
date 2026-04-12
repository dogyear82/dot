const DEFAULT_SAFE_LIMIT = 1800;

export function splitDiscordMessage(content: string, maxLength = DEFAULT_SAFE_LIMIT): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const blocks = splitIntoBlocks(content);
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const blockChunks = splitOversizedBlock(block, maxLength);
    for (const blockChunk of blockChunks) {
      if (!current) {
        current = blockChunk;
        continue;
      }

      const candidate = `${current}\n\n${blockChunk}`;
      if (candidate.length <= maxLength) {
        current = candidate;
        continue;
      }

      chunks.push(current);
      current = blockChunk;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitIntoBlocks(content: string): string[] {
  const lines = content.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (!inFence && line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }

    current.push(line);

    if (isFenceLine(line)) {
      inFence = !inFence;
    }
  }

  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }

  return blocks;
}

function splitOversizedBlock(block: string, maxLength: number): string[] {
  if (block.length <= maxLength) {
    return [block];
  }

  if (isFencedBlock(block)) {
    return splitFencedCodeBlock(block, maxLength);
  }

  const sentenceChunks = splitByRegex(block, /[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+\s*$/g, maxLength);
  if (sentenceChunks.length > 1) {
    return sentenceChunks;
  }

  const wordChunks = splitByRegex(block, /\S+\s*/g, maxLength);
  if (wordChunks.length > 1) {
    return wordChunks;
  }

  return hardSplit(block, maxLength);
}

function splitByRegex(block: string, regex: RegExp, maxLength: number): string[] {
  const segments = block.match(regex);
  if (!segments || segments.length <= 1) {
    return [block];
  }

  const chunks: string[] = [];
  let current = "";

  for (const segment of segments) {
    if (segment.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardSplit(segment, maxLength));
      continue;
    }

    if (!current) {
      current = segment;
      continue;
    }

    if ((current + segment).length <= maxLength) {
      current += segment;
      continue;
    }

    chunks.push(current);
    current = segment;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function splitFencedCodeBlock(block: string, maxLength: number): string[] {
  const lines = block.split("\n");
  const opener = lines[0] ?? "```";
  const closer = lines[lines.length - 1] ?? "```";
  const bodyLines = lines.slice(1, -1);
  const wrapperLength = opener.length + closer.length + 2;
  const maxBodyLength = Math.max(1, maxLength - wrapperLength);
  const chunks: string[] = [];
  let currentBody = "";

  const pushChunk = () => {
    if (!currentBody) {
      return;
    }

    chunks.push(`${opener}\n${currentBody}\n${closer}`);
    currentBody = "";
  };

  for (const line of bodyLines) {
    const lineWithBreak = currentBody ? `\n${line}` : line;
    if ((currentBody + lineWithBreak).length <= maxBodyLength) {
      currentBody += lineWithBreak;
      continue;
    }

    if (line.length > maxBodyLength) {
      pushChunk();
      for (const fragment of hardSplit(line, maxBodyLength)) {
        chunks.push(`${opener}\n${fragment}\n${closer}`);
      }
      continue;
    }

    pushChunk();
    currentBody = line;
  }

  pushChunk();
  return chunks;
}

function hardSplit(content: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < content.length) {
    chunks.push(content.slice(offset, offset + maxLength));
    offset += maxLength;
  }

  return chunks;
}

function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith("```");
}

function isFencedBlock(block: string): boolean {
  const lines = block.split("\n");
  return lines.length >= 2 && isFenceLine(lines[0] ?? "") && isFenceLine(lines[lines.length - 1] ?? "");
}
