module.exports = function(ctx) {
  return {
    plugins: {
      cssnano:
        ctx.env === 'production' ? {zindex: false, discardUnused: false} : false
    }
  };
};
