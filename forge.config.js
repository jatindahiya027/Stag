module.exports = {
  packagerConfig: {
    asar: true,
    icon: 'C:/Users/91741/Downloads/eagle_clone_app/eagle_app_clone/src/icon/icon.ico' // no file extension required
    
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        setupIcon:'C:/Users/91741/Downloads/eagle_clone_app/eagle_app_clone/src/icon/icon.ico'
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
