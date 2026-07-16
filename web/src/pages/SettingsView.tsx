import { RemoteCards } from "@/components/settings/RemoteCards";
import { ReloginCard } from "@/components/settings/ReloginCard";
import { PowerModeCard } from "@/components/settings/PowerModeCard";
import { ScheduleCard } from "@/components/settings/ScheduleCard";
import { AdminPasswordCard } from "@/components/settings/AdminPasswordCard";

export function SettingsView() {
  return (
    <div id="view-settings" className="view active">
      <section className="section" aria-labelledby="settings-title">
        <div className="section-head">
          <div>
            <h2 id="settings-title" className="section-title">设置</h2>
          </div>
        </div>
        <RemoteCards />
        <ReloginCard />
        <PowerModeCard />
        {/* Only mounted while settings is visible, so 15s polling is scoped. */}
        <ScheduleCard active />
        <AdminPasswordCard />
      </section>
    </div>
  );
}
