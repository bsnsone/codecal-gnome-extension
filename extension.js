import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup'; // FIX #2: Removed "?version=3.0"
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL = 'https://tukitaki.vercel.app/api/contests';

const CodeCalIndicator = GObject.registerClass(
class CodeCalIndicator extends PanelMenu.Button {
    _init(extensionUuid) {
        super._init(0.0, 'CodeCal', false);
        this._uuid = extensionUuid;

        this._label = new St.Label({
            text: 'Loading...',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._upcomingContests = [];
        this._runningContests = [];
        this._notifyEnabled = true;
        this._notificationSentFor = null;
        this._timerId = null;
        this._httpSession = new Soup.Session();

        this._buildMenu();
        this._fetchContests();

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updateUI();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildMenu() {
        this.menu.removeAll();

        // --- SECTION 1: RUNNING CONTESTS ---
        if (this._runningContests.length > 0) {
            let runningHeader = new PopupMenu.PopupMenuItem("🟢 Running Now", { reactive: false });
            runningHeader.label.clutter_text.set_markup(`<b><span foreground="#ff6b6b">🟢 Running Now</span></b>`);
            this.menu.addMenuItem(runningHeader);

            this._runningContests.forEach(contest => {
                let item = new PopupMenu.PopupMenuItem(contest.name);
                item.connect('activate', () => this._openUrl(contest.url));
                this.menu.addMenuItem(item);
            });
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // --- SECTION 2: NEXT UPCOMING CONTEST ---
        if (this._upcomingContests.length > 0) {
            let next = this._upcomingContests[0];
            
            let titleItem = new PopupMenu.PopupMenuItem(next.name, { reactive: false });
            titleItem.label.clutter_text.set_markup(`<b>${next.name}</b>`);
            this.menu.addMenuItem(titleItem);

            let dateStr = this._formatDateCustom(next.objDate);
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Start: ${dateStr}`, { reactive: false }));
            
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Duration: ${next.duration}`, { reactive: false }));

            let openItem = new PopupMenu.PopupMenuItem("Open Contest Page");
            openItem.connect('activate', () => this._openUrl(next.url));
            this.menu.addMenuItem(openItem);
        } else {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem("No upcoming contests", { reactive: false }));
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- SECTION 3: OPTIONS ---
        let notifySwitch = new PopupMenu.PopupSwitchMenuItem("Notify 5m before", this._notifyEnabled);
        notifySwitch.connect('toggled', (item) => {
            this._notifyEnabled = item.state;
        });
        this.menu.addMenuItem(notifySwitch);

        let refreshItem = new PopupMenu.PopupMenuItem("Refresh Data");
        refreshItem.connect('activate', () => {
            this._label.set_text("Refreshing...");
            this._fetchContests();
        });
        this.menu.addMenuItem(refreshItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- SECTION 4: UPCOMING LIST ---
        let upcomingSubMenu = new PopupMenu.PopupSubMenuMenuItem("Upcoming Contests");
        this._upcomingContests.slice(1, 10).forEach(contest => {
            let shortName = contest.name.length > 25 ? contest.name.substring(0, 25) + '...' : contest.name;
            let dateShort = this._formatDateShort(contest.objDate);
            let item = new PopupMenu.PopupMenuItem(`${shortName} (${dateShort})`);
            item.connect('activate', () => this._openUrl(contest.url));
            upcomingSubMenu.menu.addMenuItem(item);
        });
        this.menu.addMenuItem(upcomingSubMenu);
    }

    _fetchContests() {
        let message = new Soup.Message({ method: 'GET', uri: GLib.Uri.parse(API_URL, GLib.UriFlags.NONE) });
        
        this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                let decoder = new TextDecoder();
                let jsonString = decoder.decode(bytes.get_data());
                let data = JSON.parse(jsonString);
                this._processData(data);
            } catch (e) {
                // If the error is "Cancelled", it's because we aborted the session on destroy
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    console.error(`[CodeCal] Fetch error: ${e}`);
                    this._label.set_text("Error");
                }
            }
        });
    }

    _processData(data) {
        let upcoming = [];
        let running = [];
        const now = new Date();

        Object.keys(data).forEach(monthKey => {
            let monthData = data[monthKey];
            Object.keys(monthData).forEach(dayPlatformKey => {
                let contests = monthData[dayPlatformKey];
                contests.forEach(c => {
                    let startDateStr = c.time.replace(' ', 'T');
                    let startDate = new Date(startDateStr);
                    c.objDate = startDate;

                    let endDate = null;
                    if (c.end_time) {
                        let endDateStr = c.end_time.replace(' ', 'T');
                        endDate = new Date(endDateStr);
                    }
                    
                    if (startDate > now) {
                        upcoming.push(c);
                    } else if (endDate && startDate <= now && endDate > now) {
                        running.push(c);
                    }
                });
            });
        });

        upcoming.sort((a, b) => a.objDate - b.objDate);

        this._upcomingContests = upcoming;
        this._runningContests = running;

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._buildMenu();
            this._updateUI();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateUI() {
        if (this._runningContests.length > 0) {
            let now = new Date();
            let activeRunning = this._runningContests.filter(c => {
                let endDate = new Date(c.end_time.replace(' ', 'T'));
                return endDate > now;
            });

            if (activeRunning.length !== this._runningContests.length) {
                this._fetchContests();
                return;
            }

            this._label.set_text("Running");
            return;
        }

        if (this._upcomingContests.length === 0) {
            this._label.set_text("No Contests");
            return;
        }

        let next = this._upcomingContests[0];
        let now = new Date();
        let diff = next.objDate - now;

        if (diff <= 0) {
            this._fetchContests(); 
            return;
        }

        let hours = Math.floor(diff / (1000 * 60 * 60));
        let minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        this._label.set_text(`Next: ${hours}h ${minutes}m`);

        if (this._notifyEnabled && diff < 330000 && diff > 270000) {
            if (this._notificationSentFor !== next.name) {
                this._sendNotification(next.name);
                this._notificationSentFor = next.name;
            }
        }
    }

    _sendNotification(contestName) {
        Main.notify(
            "CodeCal Alert",
            `${contestName} starts in 5 minutes.`
        );
    }

    _openUrl(url) {
        Gio.AppInfo.launch_default_for_uri(url, null);
    }

    _formatDateCustom(date) {
        let day = date.getDate();
        let month = date.toLocaleDateString('en-US', { month: 'short' });
        let year = date.getFullYear();
        let time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        time = time.replace(' ', '');
        return `${day}'${month} ${year}, ${time}`;
    }

    _formatDateShort(date) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    // FIX #5: Renamed to destroy() to match standard convention
    destroy() {
        // FIX #4: Abort the Soup Session on destroy
        if (this._httpSession) {
            this._httpSession.abort();
            this._httpSession = null;
        }

        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        
        super.destroy(); 
    }
});

export default class CodeCalExtension extends Extension {
    enable() {
        this._indicator = new CodeCalIndicator(this.uuid);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0);
    }

    disable() {
        if (this._indicator) {
            // FIX #5: Call the renamed destroy method
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
