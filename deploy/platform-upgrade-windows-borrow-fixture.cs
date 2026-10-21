// Native test fixture only. Compile together with the unchanged product helper.
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
public static class UpgradeBorrowFixture {
  public static int Main(string[] args) {
    string stage="input";
    IntPtr borrowed=IntPtr.Zero;
    // An independent kernel-process lifetime bound also covers blocked test I/O.
    using(var deadline=new Timer(_=>Environment.Exit(78),null,30000,Timeout.Infinite)) {
      try {
        File.WriteAllText(args[2],"{\"stage\":\"started\"}");
        string[] request=File.ReadAllLines(args[0]);
        stage="borrow";
        borrowed=UpgradeWindows.BorrowLease(Int32.Parse(request[0]),request[1],request[2]);
        File.WriteAllText(args[1],Process.GetCurrentProcess().Id.ToString());
        stage="holding";
        Thread.Sleep(Timeout.Infinite);
        return 0;
      } catch(Exception error) {
        File.WriteAllText(args[2],"{\"stage\":\""+stage+"\",\"hresult\":"+error.HResult+"}");
        return 74;
      } finally {UpgradeWindows.CloseLease(borrowed);}
    }
  }
}
