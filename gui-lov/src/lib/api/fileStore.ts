/**
 * Storage definitions, and the files in them.
 *
 * Uploads go through raw `fetch` rather than `apiClient`, because the browser must set
 * `Content-Type` itself: it is the only thing that knows the multipart boundary, and setting the
 * header by hand produces a body the server cannot parse.
 */
import { API_URL, ApiClientError, apiClient } from "@/lib/api/client";
import type { CheckResult, StoreDef, StoreDraft, StoredFile } from "@/lib/fileStore";

export const fileStoreApi = {
  listStores(projectId: string): Promise<StoreDef[]> {
    return apiClient.get<StoreDef[]>(`/projects/${projectId}/file-stores`);
  },

  createStore(projectId: string, draft: StoreDraft): Promise<StoreDef> {
    return apiClient.post<StoreDef>(`/projects/${projectId}/file-stores`, draft);
  },

  updateStore(id: string, draft: StoreDraft): Promise<StoreDef> {
    return apiClient.patch<StoreDef>(`/file-stores/${encodeURIComponent(id)}`, draft);
  },

  deleteStore(id: string): Promise<void> {
    return apiClient.delete(`/file-stores/${encodeURIComponent(id)}`);
  },

  /**
   * Which buckets this credential can see.
   *
   * Takes a draft, because the point is to answer it *while* the form is being filled in — a
   * test author has no idea what to type here, and being shown the choices turns "go and create
   * a bucket" into picking one.
   */
  buckets(projectId: string, draft: StoreDraft): Promise<string[]> {
    return apiClient.post<string[]>(`/projects/${projectId}/file-stores/buckets`, draft);
  },

  /** Make one, if the credential is allowed to. Often it is not, and that is a real answer. */
  createBucket(projectId: string, draft: StoreDraft, bucket: string): Promise<void> {
    return apiClient.post(`/projects/${projectId}/file-stores/create-bucket`, { ...draft, bucket });
  },

  /** Check a configuration that has not been saved — the point of the Test button. */
  testDraft(projectId: string, draft: StoreDraft): Promise<CheckResult> {
    return apiClient.post<CheckResult>(`/projects/${projectId}/file-stores/test`, draft);
  },

  testStore(id: string): Promise<CheckResult> {
    return apiClient.post<CheckResult>(`/file-stores/${encodeURIComponent(id)}/test`);
  },

  listFiles(storeId: string): Promise<StoredFile[]> {
    return apiClient.get<StoredFile[]>(`/file-stores/${encodeURIComponent(storeId)}/files`);
  },

  /**
   * Upload one or more files in a single request.
   *
   * One request for the whole selection, because "select one or more files" is a single action
   * and five separate failures for it would be five things to make sense of.
   */
  async upload(storeId: string, files: File[]): Promise<StoredFile[]> {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);

    const res = await fetch(`${API_URL}/file-stores/${encodeURIComponent(storeId)}/files`, {
      method: "POST",
      // Deliberately no Content-Type: the browser adds it with the boundary.
      body: form,
    });
    if (!res.ok) {
      let code = "UNKNOWN_ERROR";
      let message = res.statusText || "Upload failed";
      try {
        const body = await res.json();
        code = body.code ?? code;
        // The server names the human part `error` — see the note in client.ts.
        message = body.error ?? body.message ?? message;
      } catch {
        /* not our error shape; keep the status text */
      }
      throw new ApiClientError(res.status, code, message);
    }
    return res.json();
  },

  deleteFile(storeId: string, key: string): Promise<void> {
    return apiClient.delete(
      `/file-stores/${encodeURIComponent(storeId)}/files?key=${encodeURIComponent(key)}`,
    );
  },
};
