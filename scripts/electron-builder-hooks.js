const { validatePackagedTarget } = require('./validate-packaged-native-deps')
const { Arch } = require('builder-util')

exports.afterPack = async context => {
  const target = `${context.electronPlatformName}-${Arch[context.arch]}`
  validatePackagedTarget(target, context.appOutDir, context.packager.appInfo.productFilename)
}
