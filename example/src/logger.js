export default {
  log(message) {
    console.log(`[LOG] ${new Date().toISOString()}: ${message}`);
  },
  error(message) {
    console.error(`[ERR] ${new Date().toISOString()}: ${message}`);
  },
};
