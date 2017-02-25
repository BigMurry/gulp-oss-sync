/**
 * This file is based on gulp-awspublish
 */

const OSS = require('ali-oss');
const co = require('co');
const fs = require('fs');
const through = require('through2');
const crypto = require('crypto');
const mime = require('mime');
const gutil = require('gulp-util');

var PLUGIN_NAME = 'gulp-oss-sync';

/**
 * calculate file hash
 * @param  {Buffer} buf
 * @return {String}
 *
 * @api private
 */

function md5Hash (buf) {
  return crypto
    .createHash('md5')
    .update(buf)
    .digest('hex');
}

/**
 * Determine the content type of a file based on charset and mime type.
 * @param  {Object} file
 * @return {String}
 *
 * @api private
 */

function getContentType (file) {
  var mimeType = mime.lookup(file.unzipPath || file.path);
  var charset = mime.charsets.lookup(mimeType);

  return charset
    ? mimeType + '; charset=' + charset.toLowerCase()
    : mimeType;
}

/**
 * init file oss hash
 * @param  {Vinyl} file file object
 *
 * @return {Vinyl} file
 * @api private
 */

function initFile (file) {
  if (!file.oss) {
    file.oss = {};
    file.oss.headers = {};
    file.oss.path = file.relative.replace(/\\/g, '/');
  }
  return file;
}

function saveCache (cache, filename) {
  fs.writeFileSync(filename, JSON.stringify(cache));
}

function report (newCache, oldCache) {
  const s = {
    new: '[newfile]',
    ign: '[ignored]',
    rep: '[replace]',
    del: '[deleted]'
  };
  Object.keys(newCache).forEach(function (path) {
    let state;
    if (!oldCache.hasOwnProperty(path)) {
      state = gutil.colors.green(s.new);
    } else if (oldCache[path] === newCache[path]) {
      state = gutil.colors.grey(s.ign);
    } else {
      state = gutil.colors.yellow(s.rep);
    }
    gutil.log(state, path);
  });
  Object.keys(oldCache).forEach(function (path) {
    if (!newCache.hasOwnProperty(path)) {
      let state = gutil.colors.red(s.del);
      gutil.log(state, path);
    }
  });
}

/**
 * create a new Publisher
 * @param {Object} OSS options as per https://help.aliyun.com/document_detail/32070.html
 * @api private
 */

/**
 * ossConfig = {
 *  connect: {},
 *  controls: {},
 *  setting: {}
 * }
 *
 */

function Publisher (ossConfig, cacheOptions) {
  this.config = ossConfig;
  this.client = new OSS(ossConfig.connect);
  this._newCache = {};
  var bucket = this.config.connect.bucket;

  if (!bucket) {
    throw new Error('Missing `connect.bucket` config value.');
  }

  // init Cache file
  this._cacheFile = cacheOptions && cacheOptions.cacheFileName
    ? cacheOptions.cacheFileName
    : '.oss-cache-' + bucket;

  // load cache
  try {
    this._oldCache = JSON.parse(fs.readFileSync(this.getCacheFilename(), 'utf8'));
  } catch (err) {
    this._oldCache = {};
  }
}

/**
 * generates cache filename.
 * @return {String}
 * @api private
 */

Publisher.prototype.getCacheFilename = function () {
  return this._cacheFile;
};

/**
 * create a through stream that publish files to oss
 * @options {Object} options
 *
 * available options are:
 * - force {Boolean} force upload
 * - simulate: debugging option to simulate oss upload
 * - createOnly: skip file updates
 *
 * @return {Stream}
 * @api public
 */

Publisher.prototype.push = function () {
  const _this = this;
  const _newCache = _this._newCache;
  const _oldCache = _this._oldCache;
  const options = _this.config.setting || {noClean: false, quiet: true, force: false};
  const storeCache = function () {
    return saveCache(_newCache, _this.getCacheFilename());
  };
  let counter = 0;

  function onFinish () {
    storeCache();
    if (!options || options.noClean) return;
    const objs = Object.keys(_oldCache)
      .filter(function (path) {
        return !_newCache.hasOwnProperty(path);
      })
      .map(function (path) { return `${_this.config.setting.dir}/${path}`; });
    if (objs.length > 0) {
      co(function* () {
        yield _this.client.deleteMulti(objs, {quiet: options.quiet});
      }).catch(function (err) {
        gutil.log('[Cleanup failed]', err);
      });
    }
    report(_newCache, _oldCache);
  }

  const stream = through.obj(function (file, enc, cb) {
    var etag;

    // Do nothing if no contents
    if (file.isNull()) return cb();

    // streams not supported
    if (file.isStream()) {
      this.emit('error',
        new gutil.PluginError(PLUGIN_NAME, 'Stream content is not supported'));
      return cb();
    }

    // check if file.contents is a `Buffer`
    if (file.isBuffer()) {
      initFile(file);

      // calculate etag
      etag = '"' + md5Hash(file.contents) + '"';

      // set new cache object
      _newCache[file.oss.path] = etag;

      // check if file is identical as the one in cache
      if (!options.force && _this._oldCache[file.oss.path] === etag) {
        file.oss.state = 'cache';
        return cb(null, file);
      } else {
        file.oss.state = 'upload';
        file.oss.etag = etag;
        file.oss.date = new Date();
      }

      // add content-type header
      if (!file.oss.headers['Content-Type']) file.oss.headers['Content-Type'] = getContentType(file);

      // add content-length header
      if (!file.oss.headers['Content-Length']) file.oss.headers['Content-Length'] = file.contents.length;

      if (options.simulate) return cb(null, file);

      const controls = Object.assign({}, _this.config.controls, {headers: file.oss.headers});

      co(function* () {
        yield _this.client.put(`${_this.config.setting.dir}/${file.oss.path}`, file.contents, controls);
        if (++counter % 10 === 0) storeCache();
        cb(null, file);
      }).catch(function (err) {
        cb(err, file);
      });
    }
  });
  stream.on('finish', onFinish);
  return stream;
};

/**
 * export Publisher.push
 *
 * @param {Object} ossConfig
 * @param {Object} cacheOptions
 * @return {Publisher}
 *
 * @api public
 */
module.exports = function (ossConfig, cacheOptions) {
  const publisher = new Publisher(ossConfig, cacheOptions);
  return publisher.push();
};
