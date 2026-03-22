import { InfiniteData } from "@tanstack/react-query";
import { PaperWithTags, Project, Tag } from "@/types/database";

export interface PapersPage {
  papers: PaperWithTags[];
  projects: Project[];
  tags: Tag[];
  hasMore: boolean;
}

export type CacheSnapshot = {
  papers: InfiniteData<PapersPage> | undefined;
  count: number | undefined;
};
