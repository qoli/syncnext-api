import {
  fetchPageById,
  fetchBlocks,
  fetchTableData,
  fetchNotionUsers,
} from "../notion-api/notion.js";
import {
  getFirstNotionRecordValue,
  getNotionValue,
  parsePageId,
} from "../notion-api/utils.js";
import {
  RowContentType,
  CollectionType,
  CollectionViewValueType,
  RowType,
  HandlerRequest,
} from "../notion-api/types.js";
import { createResponse } from "../utils/response.js";
import { getNotionToken } from "../utils/index.js";

export const getTableData = async (
  collection: CollectionType,
  collectionViewId: string,
  notionToken?: string,
  raw?: boolean
) => {
  const table = await fetchTableData(
    collection.value.id,
    collectionViewId,
    notionToken
  );

  const collectionRows = collection.value.schema;
  const collectionColKeys = Object.keys(collectionRows);

  const blockIds: string[] =
    table.result?.reducerResults?.collection_group_results?.blockIds || [];
  const tableBlocks = table.recordMap.block || {};

  const missingBlockIds = blockIds.filter((id) => !tableBlocks[id]?.value);
  if (missingBlockIds.length > 0) {
    const synced = await fetchBlocks(missingBlockIds, notionToken);
    Object.assign(tableBlocks, synced.recordMap?.block || {});
  }

  const normalizeBlock = (block: any): RowType | undefined => {
    if (!block) return undefined;
    // Newer Notion responses can nest block data as block.value.value.
    if (block.value?.value) return block.value as RowType;
    return block as RowType;
  };

  const tableArr: RowType[] = blockIds
    .map((id: string) => normalizeBlock(tableBlocks[id]))
    .filter(Boolean) as RowType[];

  const tableData = tableArr.filter(
    (b) =>
      b.value && b.value.properties && b.value.parent_id === collection.value.id
  );

  type Row = { id: string; [key: string]: RowContentType };

  const rows: Row[] = [];

  for (const td of tableData) {
    let row: Row = { id: td.value.id };

    for (const key of collectionColKeys) {
      const val = td.value.properties[key];
      if (val) {
        const schema = collectionRows[key];
        row[schema.name] = raw ? val : getNotionValue(val, schema.type, td);
        if (schema.type === "person" && row[schema.name]) {
          const users = await fetchNotionUsers(row[schema.name] as string[]);
          row[schema.name] = users as any;
        }
      }
    }
    rows.push(row);
  }

  return { rows, schema: collectionRows };
};

export async function tableRoute(c: HandlerRequest) {
  const pageId = parsePageId(c.req.param("pageId"));
  const notionToken = getNotionToken(c);
  const page = await fetchPageById(pageId!, notionToken);

  if (!page.recordMap.collection)
    return createResponse(
      JSON.stringify({ error: "No table found on Notion page: " + pageId }),
      { headers: {}, statusCode: 401, request: c }
    );

  const collectionValue = getFirstNotionRecordValue(page.recordMap.collection);
  const collectionView = getFirstNotionRecordValue<CollectionViewValueType>(
    page.recordMap.collection_view
  );
  const collection: CollectionType | undefined = collectionValue
    ? { value: collectionValue }
    : undefined;

  if (!collection?.value?.id || !collectionView?.id) {
    return createResponse(
      JSON.stringify({ error: "Invalid table metadata on Notion page: " + pageId }),
      { headers: {}, statusCode: 500, request: c }
    );
  }

  const { rows } = await getTableData(
    collection,
    collectionView.id,
    notionToken
  );

  return createResponse(rows, { request: c });
}
