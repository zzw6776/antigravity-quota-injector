export function windowsInstallerArguments({
  version,
  inputExecutable,
  appIcon,
  nodeLicense,
  outputExecutable,
  scriptPath,
}) {
  return [
    '/INPUTCHARSET',
    'UTF8',
    `/DVERSION=${version}`,
    `/DINPUT_EXE=${inputExecutable}`,
    `/DAPP_ICON=${appIcon}`,
    `/DNODE_LICENSE=${nodeLicense}`,
    `/DOUTPUT_EXE=${outputExecutable}`,
    scriptPath,
  ];
}
