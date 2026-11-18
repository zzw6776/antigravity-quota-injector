Option Explicit

Function ReadTrimmedText(filePath)
  ReadTrimmedText = ""
  On Error Resume Next
  Dim stream
  Set stream = CreateObject("ADODB.Stream")
  If Err.Number = 0 Then
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.LoadFromFile filePath
    If Err.Number = 0 Then
      ReadTrimmedText = Trim(Replace(Replace(stream.ReadText, vbCr, ""), vbLf, ""))
    End If
    stream.Close
  End If
  If ReadTrimmedText = "" Then
    Err.Clear
    Dim fsoLocal, ts
    Set fsoLocal = CreateObject("Scripting.FileSystemObject")
    Set ts = fsoLocal.OpenTextFile(filePath, 1, False)
    If Err.Number = 0 Then
      ReadTrimmedText = Trim(Replace(Replace(ts.ReadAll, vbCr, ""), vbLf, ""))
      ts.Close
    End If
  End If
  On Error GoTo 0
End Function

Function FindNodeExe(fso, shell, nodePathFile)
  FindNodeExe = ""
  Dim candidate
  If fso.FileExists(nodePathFile) Then
    candidate = ReadTrimmedText(nodePathFile)
    If candidate <> "" And fso.FileExists(candidate) Then
      FindNodeExe = candidate
      Exit Function
    End If
  End If

  Dim commonPaths, i
  commonPaths = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%NVM_SYMLINK%\node.exe"), _
    shell.ExpandEnvironmentStrings("%USERPROFILE%\.volta\bin\node.exe") _
  )
  For i = 0 To UBound(commonPaths)
    If InStr(commonPaths(i), "%") = 0 And fso.FileExists(commonPaths(i)) Then
      FindNodeExe = commonPaths(i)
      Exit Function
    End If
  Next

  Dim pathEnv, dirs, d, p
  pathEnv = shell.ExpandEnvironmentStrings("%PATH%")
  dirs = Split(pathEnv, ";")
  For Each d In dirs
    d = Trim(Replace(d, """", ""))
    If d <> "" Then
      p = fso.BuildPath(d, "node.exe")
      If fso.FileExists(p) Then
        FindNodeExe = p
        Exit Function
      End If
    End If
  Next
End Function

Dim fso, shell, scriptDir, projectRoot, cliPath, stateDir, nodePathFile, nodeExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
cliPath = fso.BuildPath(projectRoot, "src\cli.mjs")

If Not fso.FileExists(cliPath) Then
  MsgBox "cli.mjs not found: " & cliPath, vbCritical, "Antigravity Quota"
  WScript.Quit 1
End If

stateDir = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.gemini\antigravity\quota-injector"
nodePathFile = stateDir & "\node-path.txt"
nodeExe = FindNodeExe(fso, shell, nodePathFile)

If nodeExe = "" Then
  MsgBox "Node.js (>= 22.13.0) was not found." & vbCrLf & "Please install Node.js 22.13+ or run: npm run install-app", vbExclamation, "Antigravity Quota"
  WScript.Quit 1
End If

shell.CurrentDirectory = projectRoot
shell.Run """" & nodeExe & """ """ & cliPath & """ launch", 0, False
