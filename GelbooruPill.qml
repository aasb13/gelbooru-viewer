import QtQuick
import qs.Common
import qs.DCommon.Widgets
import qs.Modules.Plugins

PluginComponent {
    id: root

    readonly property bool viewerOpen: pluginData.viewerOpen ?? false

    function toggleViewer() {
        pluginService?.savePluginData(pluginId, "viewerOpen", !(pluginData.viewerOpen ?? false))
    }

    pillClickAction: (x, y, width, section, screen) => root.toggleViewer()

    ccWidgetIcon: "image"
    ccWidgetPrimaryText: "Gelbooru"
    ccWidgetSecondaryText: root.viewerOpen ? "Viewer open" : "Open viewer"
    ccWidgetIsActive: root.viewerOpen
    ccWidgetIsToggle: false

    onCcWidgetToggled: {
        pluginService?.savePluginData(pluginId, "viewerOpen", true)
    }

    horizontalBarPill: Component {
        Row {
            spacing: Theme.spacingXS

            DIcon {
                anchors.verticalCenter: parent.verticalCenter
                name: "image"
                size: root.iconSize
                color: root.viewerOpen ? Theme.primary : Theme.widgetIconColor
            }
        }
    }

    verticalBarPill: Component {
        Column {
            DIcon {
                anchors.horizontalCenter: parent.horizontalCenter
                name: "image"
                size: root.iconSize
                color: root.viewerOpen ? Theme.primary : Theme.widgetIconColor
            }
        }
    }
}
