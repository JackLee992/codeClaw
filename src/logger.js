export const logger = {
  info(message, meta) {
    log("INFO", message, meta);
  },
  warn(message, meta) {
    log("WARN", message, meta);
  },
  error(message, meta) {
    log("ERROR", message, meta);
  }
};

function log(level, message, meta) {
  const payload = {
    level,
    time: new Date().toISOString(),
    message
  };

  if (meta !== undefined) {
    payload.meta = meta;
  }

  console.log(JSON.stringify(payload));
}
