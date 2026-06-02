// types/comment.ts
// Typen für Job-Kommentare (append-only, MVP).

export type JobComment = {
  id: string;
  jobId: string;
  // author_id ist in der DB nullable (on delete set null) → kann fehlen,
  // wenn der Autor die Firma verlassen hat.
  authorId: string | null;
  authorName: string | null;
  message: string;
  createdAt: string;
};

export type CreateCommentInput = {
  jobId: string;
  message: string;
};
