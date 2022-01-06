/**
 * This file is based on gulp-awspublish
 */

const OSS = require('ali-oss');
const co = require('co');
const fs = require('fs');
const through = require('through2');
const crypto = require('crypto');
const mime = require('mime');
const log = require('fancy-log');
const colors = require('ansi-colors');
const PluginError = require('plugin-error');
const Spinner = require('cli-spinner').Spinner;

var PLUGIN_NAME = 'gulp-oss-sync';

function charsets(mimeType, fallback) {
    // Assume text types are utf8
    return (/^text\/|^application\/(javascript|json)/).test(mimeType) ? 'UTF-8' : fallback;
}

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
  var mimeType = mime.getType(file.unzipPath || file.path);
  var charset = charsets(mimeType);

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

function initFile (file, callback) {
  callback = callback || function (str) { return str; };
  if (!file.oss) {
    file.oss = {};
    file.oss.headers = {};
    file.oss.path = callback(file.relative.replace(/\\/g, '/'));
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
  const count = {
    new: 0,
    ign: 0,
    rep: 0,
    del: 0
  };
  Object.keys(newCache).forEach(function (path) {
    let state;
    if (!oldCache.hasOwnProperty(path)) {
      state = colors.green(s.new);
      count.new++;
    } else if (oldCache[path] === newCache[path]) {
      state = colors.grey(s.ign);
      count.ign++;
    } else {
      state = colors.yellow(s.rep);
      count.rep++;
    }
    log(state, path);
  });
  Object.keys(oldCache).forEach(function (path) {
    if (!newCache.hasOwnProperty(path)) {
      let state = colors.red(s.del);
      count.del++;
      log(state, path);
    }
  });
  log(`created: ${colors.green(count.new)}; ignored: ${colors.grey(count.ign)}; updated: ${colors.yellow(count.rep)}; deleted: ${colors.red(count.del)}`);
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
  if (ossConfig.setting.force) {
    try {
      fs.unlinkSync(this.getCacheFilename());
    } catch (err) {} finally {
      this._oldCache = {};
    }
  } else {
    try {
      this._oldCache = JSON.parse(fs.readFileSync(this.getCacheFilename(), 'utf8'));
    } catch (err) {
      this._oldCache = {};
    }
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
  const spinner = new Spinner('Now publish files ... %s');
  spinner.setSpinnerString('|/-\\');
  spinner.start();

  function onFinish () {
    spinner.stop(true);
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
        log('[Cleanup failed]', err);
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
        new PluginError(PLUGIN_NAME, 'Stream content is not supported'));
      return cb();
    }

    // check if file.contents is a `Buffer`
    if (file.isBuffer()) {
      initFile(file, _this.config.setting.fileName);

      // calculate etag
      etag = '"' + md5Hash(file.contents) + '"';

      // set new cache object
      _newCache[file.oss.path] = etag;

      // check if file is identical as the one in cache
      if (_this._oldCache[file.oss.path] === etag) {
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

      const controls = _this.config.controls || {};
      controls.headers = Object.assign({}, controls.headers, file.oss.headers);
      co(function* () {
        yield _this.client.put(`${_this.config.setting.dir}/${file.oss.path}`, file.contents, controls);
        if (++counter % 10 === 0) storeCache();
        cb(null, file);
      }).catch(function (err) {
        cb(err, file);
        spinner.stop(true);
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
