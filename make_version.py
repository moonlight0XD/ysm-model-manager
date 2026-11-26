"""產生 PyInstaller 的 Windows 版本資訊檔（版本號取自 manager_app.APP_VERSION）。

用法：python make_version.py <輸出檔>
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'manager_app.py'), encoding='utf-8').read()
ver = re.search(r"^APP_VERSION\s*=\s*'([^']+)'", src, re.M).group(1)
nums = [int(x) for x in re.findall(r'\d+', ver)][:4]
nums += [0] * (4 - len(nums))
tup = ', '.join(map(str, nums))
dotted = '.'.join(map(str, nums))

info = {
    'CompanyName': 'moonlight0XD',
    'FileDescription': 'YSM 模型管理器',
    'FileVersion': dotted,
    'InternalName': 'YSM模型管理器',
    'LegalCopyright': 'Copyright (c) moonlight0XD. MIT License.',
    'OriginalFilename': f'YSM模型管理器-v{ver}.exe',
    'ProductName': 'YSM 模型管理器',
    'ProductVersion': ver,
    'Comments': '開源的 Yes Steve Model 模型整理工具 https://github.com/moonlight0XD/ysm-model-manager',
}
strings = ',\n          '.join(f'StringStruct({k!r}, {v!r})' for k, v in info.items())

out = f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers=({tup}), prodvers=({tup}), mask=0x3f, flags=0x0,
                    OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([
      StringTable('040404B0', [
          {strings}
      ])
    ]),
    VarFileInfo([VarStruct('Translation', [0x0404, 1200])])
  ]
)
"""
open(sys.argv[1], 'w', encoding='utf-8').write(out)
# 另存純版本號，給 build.bat 拿來命名 exe
open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), 'version.txt'), 'w', encoding='ascii').write(ver)
print('version', ver)
