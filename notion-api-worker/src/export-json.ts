import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";

import { fetchPageById } from "./notion-api/notion.js";
import type {
  CollectionType,
  CollectionViewValueType,
} from "./notion-api/types.js";
import {
  getFirstNotionRecordValue,
  parsePageId,
} from "./notion-api/utils.js";
import { getTableData } from "./routes/table.js";

const TABLES: Array<{ file: string; pageId: string }> = [
  { file: "source_ali.json", pageId: "273e28c85324400db3e78c7009f35214" },
  { file: "sources18.json", pageId: "362cb65cfb4f4655995d6e8d80dea41c" },
  { file: "sourcesv3.json", pageId: "58f3de30e9dc4b7f8de6a714150057f4" },
  { file: "sourcesv2.json", pageId: "da1a91b297ea4e49957643930f27c0b8" },
  { file: "appData.json", pageId: "efa6a396e3854a2592a88f787b9c4a19" },
  { file: "domainInfo.json", pageId: "8b953280c3564fb7af1ec9d8c63f584c" },
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getArg = (name: string, fallback: string): string => {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1]!;
  }
  return fallback;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const fetchRowsFromTablePage = async (
  pageId: string,
  notionToken?: string
): Promise<unknown[]> => {
  const parsedPageId = parsePageId(pageId);
  if (!parsedPageId) {
    throw new Error(`invalid pageId: ${pageId}`);
  }

  const page = await fetchPageById(parsedPageId, notionToken);
  if (!page.recordMap.collection || !page.recordMap.collection_view) {
    throw new Error(`table metadata not found for page ${pageId}`);
  }

  const collectionValue = getFirstNotionRecordValue(page.recordMap.collection);
  const collectionView = getFirstNotionRecordValue<CollectionViewValueType>(
    page.recordMap.collection_view
  );
  const collection: CollectionType | undefined = collectionValue
    ? { value: collectionValue }
    : undefined;

  if (!collection?.value?.id || !collectionView?.id) {
    throw new Error(`invalid table metadata for page ${pageId}`);
  }

  const { rows } = await getTableData(collection, collectionView.id, notionToken);
  return rows as unknown[];
};

const fetchRowsWithRetry = async (
  pageId: string,
  notionToken: string | undefined,
  maxAttempts = 3
): Promise<unknown[]> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchRowsFromTablePage(pageId, notionToken);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await wait(1000 * attempt);
      }
    }
  }
  throw lastError;
};

async function main() {
  const outDir = resolve(getArg("--out-dir", ".."));
  const notionToken = process.env.NOTION_TOKEN;

  let updatedCount = 0;
  for (const table of TABLES) {
    const outputPath = resolve(outDir, table.file);
    const hasFallback = await fileExists(outputPath);

    try {
      const rows = await fetchRowsWithRetry(table.pageId, notionToken);
      if (!Array.isArray(rows) || rows.length === 0) {
        if (hasFallback) {
          console.log(
            `::warning::${table.file} fetched empty payload; keeping existing file.`
          );
          continue;
        }
        throw new Error(`${table.file} fetched empty payload and no fallback file`);
      }

      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(rows, null, 4)}\n`, "utf-8");
      updatedCount += 1;
      console.log(`Updated ${table.file}: ${rows.length} items`);
    } catch (error) {
      if (hasFallback) {
        console.log(
          `::warning::${table.file} fetch failed (${String(error)}); keeping existing file.`
        );
        continue;
      }
      throw error;
    }
  }

  console.log(`Export complete. Updated files: ${updatedCount}/${TABLES.length}`);
}

main().catch((error) => {
  console.error(`Export failed: ${String(error)}`);
  process.exit(1);
});
