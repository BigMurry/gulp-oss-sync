const gulp = require('gulp');
const fs = require('fs');
const ossSync = require('..');

const ossConf = JSON.parse(fs.readFileSync('conf.json', 'utf8'));
const cacheConf = {
  cacheFileName: '.oss-cache-test'
};

gulp.task('default', () => {
  gulp.src(['**/*.js', '!index.js'], {cwd: './'})
    .pipe(ossSync(ossConf, cacheConf));
});
