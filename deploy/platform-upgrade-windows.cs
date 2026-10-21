// Loaded by the fixed PowerShell bridge. No shell interpolation or secret diagnostics.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class UpgradeWindows {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Reserved1, Peb, Reserved2, Reserved3, Pid, ParentPid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref SecurityAttributes security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,out ProcessInfo info,int size,out int length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileExW(string source,string target,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle,StringBuilder path,uint length,uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle,int type,uint requested,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorOwner(IntPtr descriptor,out IntPtr owner,out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle,int type,uint requested,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  static readonly IntPtr Invalid = new IntPtr(-1);
  static string Sid { get { return WindowsIdentity.GetCurrent().User.Value; } }
  static Exception Failure() { return new InvalidOperationException("WINDOWS_UPGRADE_IO_FAILED"); }

  // Local NTFS only: remote shares, alternate streams and reparse ancestors do
  // not provide this backend's local lock/durability/identity contract.
  public static string CheckPath(string path) {
    string full=Path.GetFullPath(path), root=Path.GetPathRoot(full);
    if(full.StartsWith(@"\\") || root.Length!=3 || full.IndexOf(':',2)>=0 || new DriveInfo(root).DriveFormat!="NTFS" || new DriveInfo(root).DriveType!=DriveType.Fixed) throw Failure();
    string current=full;
    while(!String.IsNullOrEmpty(current)) {
      try {if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw Failure();}
      catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
      current=Path.GetDirectoryName(current);
    }
    return full;
  }
  static SecurityAttributes Security() {
    IntPtr descriptor; uint size;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+Sid+"D:P(A;;FA;;;"+Sid+")(A;;FA;;;SY)",1,out descriptor,out size)) throw Failure();
    return new SecurityAttributes {Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor,Inherit=0};
  }
  static IntPtr Open(string path,uint access,uint share,uint creation,uint flags) {
    var security=Security();
    try {
      IntPtr handle=CreateFileW(path,access,share,ref security,creation,flags|0x00200000,IntPtr.Zero); // OPEN_REPARSE_POINT
      if(handle==Invalid) {
        if(Marshal.GetLastWin32Error()==32) throw new InvalidOperationException("WINDOWS_UPGRADE_LOCK_BUSY");
        throw Failure();
      }
      var actual=new StringBuilder(32768);
      uint size=GetFinalPathNameByHandleW(handle,actual,32768,0);
      if(size==0 || size>=32768 || !String.Equals(actual.ToString().Replace(@"\\?\", "").TrimEnd('\\'),Path.GetFullPath(path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) {CloseHandle(handle);throw Failure();}
      return handle;
    } finally {LocalFree(security.Descriptor);}
  }
  static void PrivateHandle(IntPtr handle) {
    IntPtr owner,group,dacl,sacl,descriptor;
    if(GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out descriptor)!=0) throw Failure();
    try {
      byte[] bytes=new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor,bytes,0,bytes.Length);
      var acl=new RawSecurityDescriptor(bytes,0);
      if(acl.Owner.Value!=Sid || acl.DiscretionaryAcl==null || (acl.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0) throw Failure();
      foreach(GenericAce ace in acl.DiscretionaryAcl) {
        var known=ace as CommonAce;
        if(known==null || known.IsCallback) throw Failure();
        if(known.AceQualifier==AceQualifier.AccessAllowed && known.SecurityIdentifier.Value!=Sid && known.SecurityIdentifier.Value!="S-1-5-18") throw Failure();
      }
    } finally {LocalFree(descriptor);}
  }
  public static void ProtectDirectory(string path) {
    path=CheckPath(path);
    Directory.CreateDirectory(path);
    IntPtr handle=Open(path,0x000E0000,7,3,0x02000000);
    var security=Security();
    try {
      IntPtr owner,group,dacl,sacl,existing;
      if(GetSecurityInfo(handle,1,1,out owner,out group,out dacl,out sacl,out existing)!=0) throw Failure();
      try {
        string ownerSid=new SecurityIdentifier(owner).Value;
        if(ownerSid!=Sid && !(ownerSid=="S-1-5-32-544" && new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))) throw Failure();
      }finally{LocalFree(existing);}
      bool present,defaulted;
      if(!GetSecurityDescriptorOwner(security.Descriptor,out owner,out defaulted) || !GetSecurityDescriptorDacl(security.Descriptor,out present,out dacl,out defaulted) || !present || SetSecurityInfo(handle,1,0x80000005,owner,IntPtr.Zero,dacl,IntPtr.Zero)!=0) throw Failure();
      PrivateHandle(handle);
    } finally {LocalFree(security.Descriptor);CloseHandle(handle);}
  }
  public static void AssertPrivateFile(string path) {
    path=CheckPath(path);IntPtr handle=Open(path,0x00020000,7,3,0);
    try {if((File.GetAttributes(path)&FileAttributes.Directory)!=0)throw Failure();PrivateHandle(handle);}finally{CloseHandle(handle);}
  }
  static IntPtr Parent(int pid,string expected,out string created) {
    ProcessInfo info; int length;
    if(NtQueryInformationProcess(GetCurrentProcess(),0,out info,Marshal.SizeOf(typeof(ProcessInfo)),out length)!=0 || info.ParentPid.ToInt64()!=pid) throw Failure();
    IntPtr parent=OpenProcess(0x00101040,false,pid);
    if(parent==IntPtr.Zero) throw Failure();
    try {
      long birth,exit,kernel,user,ownBirth;
      if(!GetProcessTimes(parent,out birth,out exit,out kernel,out user) || !GetProcessTimes(GetCurrentProcess(),out ownBirth,out exit,out kernel,out user)
          || birth>=ownBirth || WaitForSingleObject(parent,0)!=258) throw Failure();
      created=birth.ToString();
      if(expected!=null && expected!=created) throw Failure();
      return parent;
    } catch {CloseHandle(parent);throw;}
  }
  public static string[] Acquire(string path,int pid) {
    path=CheckPath(path); string created; IntPtr parent=Parent(pid,null,out created), handle=Invalid;
    try {
      handle=Open(path,0xC0020000,0,4,0); // OPEN_ALWAYS, no sharing (including delete)
      PrivateHandle(handle);
      IntPtr transferred;
      if(!DuplicateHandle(GetCurrentProcess(),handle,parent,out transferred,0,false,2)) throw Failure();
      return new [] {transferred.ToInt64().ToString(),created};
    } finally {if(handle!=Invalid)CloseHandle(handle);CloseHandle(parent);}
  }
  public static void Release(int pid,string handle,string creation) {
    string created; IntPtr parent=Parent(pid,creation,out created);
    try {
      IntPtr closed;
      // Never retry: CLOSE_SOURCE may have closed the handle even on an error.
      if(!DuplicateHandle(parent,new IntPtr(Int64.Parse(handle)),GetCurrentProcess(),out closed,0,false,3)) throw Failure();
      CloseHandle(closed);
    } finally {CloseHandle(parent);}
  }
  public static IntPtr BorrowLease(int pid,string handle,string creation) {
    string created;IntPtr parent=Parent(pid,creation,out created);
    try {
      IntPtr borrowed;
      if(!DuplicateHandle(parent,new IntPtr(Int64.Parse(handle)),GetCurrentProcess(),out borrowed,0,false,2)) throw Failure();
      return borrowed;
    } finally {CloseHandle(parent);}
  }
  public static void CloseLease(IntPtr handle) {if(handle!=IntPtr.Zero)CloseHandle(handle);}
  public static string ReadPrivate(string path) {
    path=CheckPath(path);
    try {if((File.GetAttributes(path)&FileAttributes.Directory)!=0)throw Failure();}
    catch(FileNotFoundException){return null;}catch(DirectoryNotFoundException){return null;}
    IntPtr handle=Open(path,0x80020000,1,3,0);
    using(var safe=new SafeFileHandle(handle,true)) {
      PrivateHandle(handle);
      using(var stream=new FileStream(safe,FileAccess.Read)) {
        if(stream.Length>536870912) throw Failure();
        byte[] bytes=new byte[(int)stream.Length]; int offset=0;
        while(offset<bytes.Length) {int read=stream.Read(bytes,offset,bytes.Length-offset);if(read==0)throw Failure();offset+=read;}
        try {return Convert.ToBase64String(bytes);} finally {Array.Clear(bytes,0,bytes.Length);}
      }
    }
  }
  public static void WritePrivate(string path,string encoded) {
    path=CheckPath(path); string temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
    Directory.CreateDirectory(Path.GetDirectoryName(path));CheckPath(path);
    byte[] bytes=Convert.FromBase64String(encoded);
    try {
      IntPtr handle=Open(temporary,0xC0020000,0,1,0x80000000); // CREATE_NEW + WRITE_THROUGH
      using(var safe=new SafeFileHandle(handle,true)) {
        PrivateHandle(handle);
        using(var stream=new FileStream(safe,FileAccess.ReadWrite)) {
          stream.Write(bytes,0,bytes.Length); stream.Flush();
          if(!FlushFileBuffers(handle)) throw Failure();
        }
      }
      Rename(temporary,path);
    } finally {Array.Clear(bytes,0,bytes.Length);if(File.Exists(temporary))File.Delete(temporary);}
  }
  public static void Rename(string source,string target) {
    source=CheckPath(source);target=CheckPath(target);
    if(Path.GetDirectoryName(source)!=Path.GetDirectoryName(target)) throw Failure();
    IntPtr handle=Open(source,0xC0020000,1,3,0x80000000);
    try {PrivateHandle(handle);if(!FlushFileBuffers(handle))throw Failure();}finally{CloseHandle(handle);}
    if(!MoveFileExW(source,target,9)) throw Failure(); // REPLACE_EXISTING | WRITE_THROUGH, never COPY_ALLOWED
    handle=Open(target,0xC0020000,1,3,0x80000000);
    try {PrivateHandle(handle);if(!FlushFileBuffers(handle))throw Failure();}finally{CloseHandle(handle);}
  }
  public static void Probe(string directory) {
    directory=CheckPath(directory);
    if(!Directory.Exists(directory))throw Failure();
    string path=Path.Combine(directory,".upgrade-durability-"+Guid.NewGuid().ToString("N"));
    try {WritePrivate(path,"");ReadPrivate(path);} finally {if(File.Exists(path))File.Delete(path);}
  }
}
