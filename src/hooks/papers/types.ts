import { InfiniteData } from "@tanstack/react-query";
import { Paper, PaperAttachment, Project, Tag } from "@/types/database";

/** Raw paper with junction IDs (not hydrated with full Project/Tag objects). */
export interface RawPaperWithJunctions extends Paper {
  tagIds: string[];
  projectIds: string[];
  paper_attachments?: PaperAttachment[];
}

/** Shape of each page in the infinite papers query. */
export interface PapersPage {
  papers: RawPaperWithJunctions[];
  hasMore: boolean;
}

export type CacheSnapshot = {
  papers: InfiniteData<PapersPage> | undefined;
  count: number | undefined;
  projects: Project[] | undefined;
  tags: Tag[] | undefined;
};
