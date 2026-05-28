import axios from "axios";
import { config } from "./config.js";

type UnknownRecord = Record<string, unknown>;

const toRecord = (value: unknown): UnknownRecord => {
  if (value && typeof value === "object") {
    return value as UnknownRecord;
  }
  return {};
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export type MenuV3PresignResult = {
  url: string;
  deliveroo: unknown;
  menuId: string;
  s3Url?: string;
  version?: string;
};

export type MenuV3S3UploadResult = {
  ok: boolean;
  httpStatus: number;
};

export type MenuV3PublishJobResult = {
  url: string;
  deliveroo: unknown;
  jobId?: string;
};

export type MenuV3JobPollResult = {
  url: string;
  deliveroo: unknown;
  status?: string;
  attempts: number;
};

export type MenuV3UploadSteps = {
  presign: MenuV3PresignResult;
  s3Upload: MenuV3S3UploadResult;
  publishJob: MenuV3PublishJobResult;
  jobPoll?: MenuV3JobPollResult;
};

const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json"
});

/** PUT /menu/v3/brands/{brand}/menus/{id} — presigned S3 URL (no body). */
export const createMenuV3PresignedUpload = async (
  brandId: string,
  menuId: string,
  token: string
): Promise<MenuV3PresignResult> => {
  const url = `${config.deliverooBaseUrl}/menu/v3/brands/${brandId}/menus/${menuId}`;
  const response = await axios.put(url, undefined, {
    headers: authHeaders(token),
    timeout: 20000
  });
  const data = response.data;
  const record = toRecord(data);
  const s3Url = asString(record.upload_url) ?? asString(record.s3_url);
  return {
    url,
    deliveroo: data,
    menuId: asString(record.id) ?? menuId,
    s3Url,
    version: asString(record.version)
  };
};

/** Upload menu JSON bytes to the presigned S3 URL from step 1. */
export const uploadMenuJsonToS3 = async (
  s3Url: string,
  bodyJson: string
): Promise<MenuV3S3UploadResult> => {
  const response = await axios.put(s3Url, bodyJson, {
    headers: { "Content-Type": "application/json" },
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    transformRequest: [(data) => data],
    validateStatus: () => true
  });
  return {
    ok: response.status >= 200 && response.status < 300,
    httpStatus: response.status
  };
};

/** POST /menu/v3/brands/{brand}/jobs — publish menu after S3 upload. */
export const publishMenuV3ToLive = async (
  brandId: string,
  menuId: string,
  token: string,
  version?: string
): Promise<MenuV3PublishJobResult> => {
  const url = `${config.deliverooBaseUrl}/menu/v3/brands/${brandId}/jobs`;
  const params: UnknownRecord = { menu_id: menuId };
  if (version) {
    params.version = version;
  }
  const response = await axios.post(
    url,
    {
      action: "publish_menu_to_live",
      params
    },
    {
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      timeout: 20000
    }
  );
  const jobId = asString(toRecord(response.data).job_id);
  return { url, deliveroo: response.data, jobId };
};

export type MenuV3JobStatus = "new" | "in_progress" | "success" | "failed" | string;

/** GET /menu/v3/brands/{brand}/jobs/{job_id}. */
export const getMenuV3JobStatus = async (
  brandId: string,
  jobId: string,
  token: string
): Promise<{ url: string; deliveroo: unknown; status?: MenuV3JobStatus }> => {
  const url = `${config.deliverooBaseUrl}/menu/v3/brands/${brandId}/jobs/${jobId}`;
  const response = await axios.get(url, {
    headers: authHeaders(token),
    timeout: 20000
  });
  return {
    url,
    deliveroo: response.data,
    status: asString(toRecord(response.data).status)
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type PollMenuV3JobOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

/** Poll job until success, failed, or timeout. */
export const pollMenuV3JobUntilDone = async (
  brandId: string,
  jobId: string,
  token: string,
  options?: PollMenuV3JobOptions
): Promise<MenuV3JobPollResult> => {
  const intervalMs = options?.intervalMs ?? 2000;
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last: { url: string; deliveroo: unknown; status?: MenuV3JobStatus } = {
    url: "",
    deliveroo: {}
  };

  while (Date.now() < deadline) {
    attempts += 1;
    last = await getMenuV3JobStatus(brandId, jobId, token);
    const status = last.status;
    if (status === "success" || status === "failed") {
      return {
        url: last.url,
        deliveroo: last.deliveroo,
        status,
        attempts
      };
    }
    await sleep(intervalMs);
  }

  return {
    url: last.url,
    deliveroo: last.deliveroo,
    status: last.status,
    attempts
  };
};

export type RunMenuV3UploadOptions = {
  brandId: string;
  menuId: string;
  bodyJson: string;
  token: string;
  pollJob?: boolean;
  jobPollTimeoutMs?: number;
};

/** Full V3 flow: presign → S3 PUT → publish job → optional job poll. */
export const runMenuV3Upload = async (
  options: RunMenuV3UploadOptions
): Promise<MenuV3UploadSteps> => {
  const presign = await createMenuV3PresignedUpload(
    options.brandId,
    options.menuId,
    options.token
  );
  if (!presign.s3Url) {
    throw new Error(
      `Menu V3 presign response missing upload_url/s3_url: ${JSON.stringify(presign.deliveroo)}`
    );
  }

  const s3Upload = await uploadMenuJsonToS3(presign.s3Url, options.bodyJson);
  if (!s3Upload.ok) {
    throw new Error(`Menu V3 S3 upload failed with HTTP ${s3Upload.httpStatus}`);
  }

  const publishJob = await publishMenuV3ToLive(
    options.brandId,
    options.menuId,
    options.token,
    presign.version
  );
  if (!publishJob.jobId) {
    throw new Error("Menu V3 publish job response missing job_id");
  }

  const steps: MenuV3UploadSteps = { presign, s3Upload, publishJob };

  if (options.pollJob !== false) {
    steps.jobPoll = await pollMenuV3JobUntilDone(
      options.brandId,
      publishJob.jobId,
      options.token,
      { timeoutMs: options.jobPollTimeoutMs ?? 60_000 }
    );
  }

  console.log(
    JSON.stringify({
      msg: "deliveroo.menu.upload.v3",
      menuId: options.menuId,
      brandId: options.brandId,
      version: presign.version,
      jobId: publishJob.jobId,
      jobStatus: steps.jobPoll?.status,
      s3HttpStatus: s3Upload.httpStatus
    })
  );

  return steps;
};
