import { fetchPageById, fetchBlocks } from "../notion-api/notion.js";
import {
  getFirstNotionRecordValue,
  getNotionRecordValue,
  parsePageId,
} from "../notion-api/utils.js";
import {
  BlockType,
  CollectionType,
  CollectionViewValueType,
  HandlerRequest,
} from "../notion-api/types.js";
import { getTableData } from "./table.js";
import { createResponse } from "../utils/response.js";
import { getNotionToken } from "../utils/index.js";

export async function pageRoute(c: HandlerRequest) {
  const pageId = parsePageId(c.req.param("pageId"));
  const notionToken = getNotionToken(c);

  const page = await fetchPageById(pageId!, notionToken);

  const baseBlocks = page.recordMap.block;

  let allBlocks: { [id: string]: BlockType & { collection?: any } } = {
    ...baseBlocks,
  };
  let allBlockKeys;

  while (true) {
    allBlockKeys = Object.keys(allBlocks);

    const pendingBlocks = allBlockKeys.flatMap((blockId) => {
      const block = allBlocks[blockId];
      const content = block.value && block.value.content;

      if (!content || (block.value.type === "page" && blockId !== pageId!)) {
        // skips pages other than the requested page
        return [];
      }

      return content.filter((id: string) => !allBlocks[id]);
    });

    if (!pendingBlocks.length) {
      break;
    }

    const newBlocks = await fetchBlocks(pendingBlocks, notionToken).then(
      (res) => res.recordMap.block
    );

    allBlocks = { ...allBlocks, ...newBlocks };
  }

  const collectionValue = getFirstNotionRecordValue(page.recordMap.collection);
  const collectionView = getFirstNotionRecordValue<CollectionViewValueType>(
    page.recordMap.collection_view
  );
  const collection: CollectionType | null = collectionValue
    ? { value: collectionValue }
    : null;

  if (collection && collectionView) {
    const pendingCollections = allBlockKeys.flatMap((blockId) => {
      const block = allBlocks[blockId];

      return block.value && block.value.type === "collection_view"
        ? [block.value.id]
        : [];
    });

    for (let b of pendingCollections) {
      const collPage = await fetchPageById(b!, notionToken);

      const collValue = getFirstNotionRecordValue(collPage.recordMap.collection);
      const collView = getFirstNotionRecordValue<CollectionViewValueType>(
        collPage.recordMap.collection_view
      );
      const coll: CollectionType | undefined = collValue
        ? { value: collValue }
        : undefined;

      if (!coll?.value?.id || !collView?.id) {
        continue;
      }

      const { rows, schema } = await getTableData(
        coll,
        collView.id,
        notionToken,
        true
      );

      const viewIds = (allBlocks[b] as any).value.view_ids as string[];

      allBlocks[b] = {
        ...allBlocks[b],
        collection: {
          title: coll.value.name,
          schema,
          types: viewIds.map((id) => {
            const col = collPage.recordMap.collection_view[id];
            return getNotionRecordValue(col);
          }),
          data: rows,
        },
      };
    }
  }

  return createResponse(allBlocks, {
    request: c,
  });
}
