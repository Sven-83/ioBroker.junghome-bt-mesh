// This file extends the AdapterConfig type from "@iobroker/types"

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Content of the JUNG HOME project export (JungHome.json), holds all mesh keys (encrypted) */
            meshExport: string;
            /** Own unicast address as 4-digit hex, outside the app range */
            ownAddress: string;
            /** Preferred ESPHome Bluetooth proxy (host or IP) */
            proxy1Host: string;
            /** Noise key of proxy 1 (encrypted), empty without API encryption */
            proxy1Key: string;
            /** Fallback ESPHome Bluetooth proxy, optional */
            proxy2Host: string;
            /** Noise key of proxy 2 (encrypted) */
            proxy2Key: string;
            /** Poll interval in minutes (fallback, the thermostat pushes setpoint changes) */
            pollMinutes: number;
            /** Boost duration in minutes */
            boostMinutes: number;
            /** Setpoint during a boost in °C */
            boostSetpoint: number;
        }
    }
}

export {};
