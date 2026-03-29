import crypto from "node:crypto";

export function decryptFeishuPayload(encryptKey, encrypted) {
  if (!encryptKey) {
    throw new Error("缺少 FEISHU_ENCRYPT_KEY。");
  }

  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const ciphertext = Buffer.from(encrypted, "base64");
  const iv = ciphertext.subarray(0, 16);
  const content = ciphertext.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);

  const decrypted = Buffer.concat([decipher.update(content), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}
